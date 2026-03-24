import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import type { ApiResponse } from '@/types';

// Process one video per pump cycle to avoid burst 429s.
// The client-side poller calls the pump every few seconds,
// so throughput is: 1 video / pump interval (e.g. 1 video every 5s).
const BATCH_SIZE = 1;
const MAX_RETRIES = 3;

// Delay between dispatching each extract request (ms).
// Only relevant if BATCH_SIZE > 1 in the future.
const DISPATCH_DELAY_MS = 2_000;

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

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
        ? `All ${failed} transcript extractions failed. YouTube may be rate-limiting — try again in a few minutes.`
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

    // While any video is still processing, wait for it to finish
    // before dispatching another — prevents concurrent requests.
    if ((currentProcessing ?? 0) > 0) {
      return NextResponse.json<ApiResponse>({
        success: true,
        data: { processed: 0, remaining: (currentPending ?? 0) + (currentProcessing ?? 0), waiting: true },
      });
    }

    const { data: batch } = await admin
      .from('job_videos')
      .select('id, video_id')
      .eq('job_id', job_id)
      .eq('transcript_status', 'pending')
      .lt('transcript_retry_count', MAX_RETRIES)
      .order('discovery_position', { ascending: true })
      .limit(BATCH_SIZE);

    if (!batch || batch.length === 0) {
      return NextResponse.json<ApiResponse>({
        success: true,
        data: { processed: 0, remaining: 0 },
      });
    }

    // Mark as processing BEFORE dispatching
    await admin
      .from('job_videos')
      .update({
        transcript_status:       'processing',
        transcript_attempted_at: new Date().toISOString(),
      })
      .in('id', batch.map(v => v.id));

    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

    // Sequential dispatch with delay — avoids burst 429s on YouTube
    for (let i = 0; i < batch.length; i++) {
      const video = batch[i];
      if (i > 0) await sleep(DISPATCH_DELAY_MS);
      fetch(`${baseUrl}/api/worker/extract`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ job_id, job_video_id: video.id, video_id: video.video_id }),
      }).catch(() => {}); // fire-and-forget; result tracked via DB
    }

    const { count: pendingAfter } = await admin
      .from('job_videos')
      .select('*', { count: 'exact', head: true })
      .eq('job_id', job_id)
      .eq('transcript_status', 'pending');

    return NextResponse.json<ApiResponse>({
      success: true,
      data: { processed: batch.length, remaining: (pendingAfter ?? 0) + batch.length },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Pump failed';
    return NextResponse.json<ApiResponse>({ success: false, error: message }, { status: 500 });
  }
}
