import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import type { ApiResponse } from '@/types';

const BATCH_SIZE = 1;
const MAX_RETRIES = 3;

// Delay between dispatching each video. 8s gives YouTube time to breathe
// and avoids triggering rate bans on sequential requests.
const DISPATCH_DELAY_MS = 8_000;

// Stale processing timeout — raised to 120s to account for yt-dlp fallback
const PROCESSING_STALE_MS = 120_000;

function sleep(ms: number) {
  return new Promise<void>(resolve => setTimeout(resolve, ms));
}

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
    '[pump/extract] NEXT_PUBLIC_APP_URL is not set — falling back to http://localhost:3000'
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

    // Unstick stale 'processing' rows
    const staleThreshold = new Date(Date.now() - PROCESSING_STALE_MS).toISOString();
    await admin
      .from('job_videos')
      .update({ transcript_status: 'pending' })
      .eq('job_id', job_id)
      .eq('transcript_status', 'processing')
      .lt('transcript_attempted_at', staleThreshold);

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

    // All done? Advance job status
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
          'Your IP is likely blocked by YouTube. Fix: ' +
          '(1) Run: pip install --upgrade youtube-transcript-api  ' +
          '(2) Make sure YOUTUBE_COOKIES_FILE is set or ~/cookies.txt exists  ' +
          '(3) Wait 30-60 minutes for the IP ban to lift  ' +
          '(4) Try with a VPN or proxy (PROXY_URL env var)'
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

    // Throttle: don't dispatch more if already processing
    if ((currentProcessing ?? 0) >= BATCH_SIZE) {
      return NextResponse.json<ApiResponse>({
        success: true,
        data: { processed: 0, remaining: (currentPending ?? 0) + (currentProcessing ?? 0), waiting: true },
      });
    }

    // Dispatch next video
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

    await admin
      .from('job_videos')
      .update({
        transcript_status:       'processing',
        transcript_attempted_at: new Date().toISOString(),
      })
      .in('id', batch.map(v => v.id));

    const baseUrl = resolveBaseUrl();
    console.log(`[pump/extract] dispatching ${batch.length} video(s) via ${baseUrl} (cooldown=${DISPATCH_DELAY_MS}ms between requests)`);

    for (let i = 0; i < batch.length; i++) {
      if (i > 0) await sleep(DISPATCH_DELAY_MS);
      const video = batch[i];
      fetch(`${baseUrl}/api/worker/extract`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ job_id, job_video_id: video.id, video_id: video.video_id }),
      }).catch((err) => {
        console.error(`[pump/extract] fire-and-forget failed for ${video.video_id}:`, err);
      });
    }

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
