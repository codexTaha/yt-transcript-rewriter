import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import type { ApiResponse } from '@/types';

// How many videos to dispatch concurrently per pump tick.
// Keep at 3 — enough parallelism without burst-triggering 429s.
const BATCH_SIZE = 3;
const MAX_RETRIES = 3;

// Max time (ms) a video is allowed to sit in 'processing' before
// we assume the worker crashed and reset it back to 'pending'.
const PROCESSING_STALE_MS = 90_000; // 90 seconds

/**
 * Resolve the base URL for internal self-calls.
 *
 * Priority:
 *   1. NEXT_PUBLIC_APP_URL env var  (set this in .env.local for local dev)
 *   2. NEXTAUTH_URL / VERCEL_URL    (common CI/hosting vars)
 *   3. http://localhost:3000         (hardcoded local fallback)
 *
 * WHY: process.env.NEXT_PUBLIC_APP_URL is often missing locally, causing
 * fire-and-forget fetch() calls to the extract worker to silently fail
 * because the URL resolves to undefined/null or a broken string.
 *
 * A console.warn is emitted when the fallback is used so developers know
 * immediately that NEXT_PUBLIC_APP_URL is missing in their .env.local.
 */
function resolveBaseUrl(): string {
  const candidates = [
    process.env.NEXT_PUBLIC_APP_URL,
    process.env.NEXTAUTH_URL,
    process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : undefined,
  ];
  for (const c of candidates) {
    if (c && c.trim() && c.trim() !== 'undefined') return c.trim().replace(/\/$/, '');
  }
  console.warn(
    '[pump/extract] NEXT_PUBLIC_APP_URL is not set in .env.local — ' +
    'falling back to http://localhost:3000. ' +
    'Set NEXT_PUBLIC_APP_URL=http://localhost:3000 in your .env.local to suppress this warning.'
  );
  return 'http://localhost:3000';
}

export async function POST(req: NextRequest) {
  const admin = createAdminClient();

  try {
    const body = await req.json();
    const { job_id } = body;

    if (!job_id) {
      return NextResponse.json<ApiResponse>(
        { success: false, error: 'job_id is required' },
        { status: 400 }
      );
    }

    const { data: job } = await admin
      .from('jobs')
      .select('status')
      .eq('id', job_id)
      .single();

    if (!job || job.status !== 'extracting') {
      return NextResponse.json<ApiResponse>({
        success: true,
        data: { processed: 0, remaining: 0, message: 'Job not in extracting state' },
      });
    }

    // --- Unstick stale 'processing' rows ---
    const staleThreshold = new Date(Date.now() - PROCESSING_STALE_MS).toISOString();
    await admin
      .from('job_videos')
      .update({ transcript_status: 'pending' })
      .eq('job_id', job_id)
      .eq('transcript_status', 'processing')
      .lt('transcript_attempted_at', staleThreshold);

    // --- Count pending / processing ---
    const { count: currentPending } = await admin
      .from('job_videos')
      .select('*', { count: 'exact', head: true })
      .eq('job_id', job_id)
      .eq('transcript_status', 'pending')
      .lt('transcript_retry_count', MAX_RETRIES);

    const { count: currentProcessing } = await admin
      .from('job_videos')
      .select('*', { count: 'exact', head: true })
      .eq('job_id', job_id)
      .eq('transcript_status', 'processing');

    // --- All done? Advance job status ---
    if ((currentPending ?? 0) === 0 && (currentProcessing ?? 0) === 0) {
      const { count: successCount } = await admin
        .from('job_videos')
        .select('*', { count: 'exact', head: true })
        .eq('job_id', job_id)
        .eq('transcript_status', 'done');

      const { count: failedCount } = await admin
        .from('job_videos')
        .select('*', { count: 'exact', head: true })
        .eq('job_id', job_id)
        .in('transcript_status', ['failed', 'skipped']);

      const success = successCount ?? 0;
      const failed  = failedCount  ?? 0;

      const nextStatus = success === 0 ? 'failed' : 'awaiting_prompt';
      const errorMsg   = success === 0
        ? `All ${failed} transcript extractions failed. ` +
          'Check: (1) YOUTUBE_COOKIES_FILE is set in .env.local, ' +
          '(2) youtube-transcript-api is installed in your venv, ' +
          '(3) PYTHON_BIN points to your venv Python.'
        : undefined;

      await admin
        .from('jobs')
        .update({
          status: nextStatus,
          transcript_success_count: success,
          transcript_failed_count:  failed,
          ...(errorMsg ? { error_message: errorMsg } : {}),
        })
        .eq('id', job_id)
        .eq('status', 'extracting');

      return NextResponse.json<ApiResponse>({
        success: true,
        data: { processed: 0, remaining: 0, advanced: true, next_status: nextStatus },
      });
    }

    // --- Throttle: don't dispatch more if already processing ---
    if ((currentProcessing ?? 0) >= BATCH_SIZE) {
      return NextResponse.json<ApiResponse>({
        success: true,
        data: { processed: 0, remaining: (currentPending ?? 0) + (currentProcessing ?? 0), waiting: true },
      });
    }

    // --- Dispatch next batch ---
    const slots = BATCH_SIZE - (currentProcessing ?? 0);
    const { data: batch } = await admin
      .from('job_videos')
      .select('id, video_id')
      .eq('job_id', job_id)
      .eq('transcript_status', 'pending')
      .lt('transcript_retry_count', MAX_RETRIES)
      .order('discovery_position', { ascending: true })
      .limit(slots);

    if (!batch || batch.length === 0) {
      return NextResponse.json<ApiResponse>({
        success: true,
        data: { processed: 0, remaining: currentProcessing ?? 0 },
      });
    }

    // Mark as processing BEFORE firing requests
    await admin
      .from('job_videos')
      .update({
        transcript_status:       'processing',
        transcript_attempted_at: new Date().toISOString(),
      })
      .in('id', batch.map(v => v.id));

    const baseUrl = resolveBaseUrl();
    console.log(`[pump/extract] dispatching ${batch.length} videos via ${baseUrl}`);

    // Fire-and-forget — results are written to DB by the extract worker
    batch.forEach(video => {
      fetch(`${baseUrl}/api/worker/extract`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ job_id, job_video_id: video.id, video_id: video.video_id }),
      }).catch((err) => {
        console.error(`[pump/extract] fire-and-forget failed for ${video.video_id}:`, err);
      });
    });

    const { count: pendingAfter } = await admin
      .from('job_videos')
      .select('*', { count: 'exact', head: true })
      .eq('job_id', job_id)
      .eq('transcript_status', 'pending');

    return NextResponse.json<ApiResponse>({
      success: true,
      data: {
        processed: batch.length,
        remaining: (pendingAfter ?? 0) + batch.length,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Pump failed';
    return NextResponse.json<ApiResponse>({ success: false, error: message }, { status: 500 });
  }
}
