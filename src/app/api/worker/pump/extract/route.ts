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
    // If a worker crashed after marking status='processing' but before
    // writing 'done'/'failed', the pump would be blocked forever.
    // Reset any row that has been 'processing' for over PROCESSING_STALE_MS.
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
        ? `All ${failed} transcript extractions failed. Try setting YOUTUBE_COOKIES_FILE in .env.local.`
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

    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

    // Fire-and-forget — results are written to DB by the extract worker
    batch.forEach(video => {
      fetch(`${baseUrl}/api/worker/extract`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ job_id, job_video_id: video.id, video_id: video.video_id }),
      }).catch(() => {});
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
