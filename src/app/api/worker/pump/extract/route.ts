import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import type { ApiResponse } from '@/types';

const BATCH_SIZE = 5;
const MAX_RETRIES = 3;

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

      // If ZERO transcripts succeeded, mark the job as failed instead of
      // advancing to awaiting_prompt (which would show a useless modal).
      const nextStatus = success === 0 ? 'failed' : 'awaiting_prompt';
      const errorMsg   = success === 0
        ? `All ${failed} transcript extractions failed. YouTube may be blocking your IP — try adding a PROXY_URL in .env.local.`
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

    if ((currentPending ?? 0) === 0 && (currentProcessing ?? 0) > 0) {
      return NextResponse.json<ApiResponse>({
        success: true,
        data: { processed: 0, remaining: currentProcessing ?? 0, waiting: true },
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
        data: { processed: 0, remaining: (currentProcessing ?? 0) },
      });
    }

    await admin
      .from('job_videos')
      .update({
        transcript_status:        'processing',
        transcript_attempted_at:  new Date().toISOString(),
      })
      .in('id', batch.map(v => v.id));

    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
    await Promise.allSettled(
      batch.map(video =>
        fetch(`${baseUrl}/api/worker/extract`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ job_id, job_video_id: video.id, video_id: video.video_id }),
        })
      )
    );

    const { count: pendingAfter } = await admin
      .from('job_videos')
      .select('*', { count: 'exact', head: true })
      .eq('job_id', job_id)
      .eq('transcript_status', 'pending');

    const { count: processingAfter } = await admin
      .from('job_videos')
      .select('*', { count: 'exact', head: true })
      .eq('job_id', job_id)
      .eq('transcript_status', 'processing');

    return NextResponse.json<ApiResponse>({
      success: true,
      data: { processed: batch.length, remaining: (pendingAfter ?? 0) + (processingAfter ?? 0) },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Pump failed';
    return NextResponse.json<ApiResponse>({ success: false, error: message }, { status: 500 });
  }
}
