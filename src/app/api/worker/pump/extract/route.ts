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

    // Stop immediately if job is not extracting
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

    // --- Count current state BEFORE claiming a new batch ---
    // This is the authoritative snapshot we reason about.
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

    // If nothing pending AND nothing processing — all work is done, advance the job.
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

      await admin
        .from('jobs')
        .update({
          status: 'awaiting_prompt',
          transcript_success_count: successCount ?? 0,
          transcript_failed_count: failedCount ?? 0,
        })
        .eq('id', job_id)
        // Only advance if still in extracting — guard against concurrent calls
        .eq('status', 'extracting');

      return NextResponse.json<ApiResponse>({
        success: true,
        data: { processed: 0, remaining: 0, advanced: true, next_status: 'awaiting_prompt' },
      });
    }

    // If nothing pending but some still processing — wait for them
    if ((currentPending ?? 0) === 0 && (currentProcessing ?? 0) > 0) {
      return NextResponse.json<ApiResponse>({
        success: true,
        data: { processed: 0, remaining: currentProcessing ?? 0, waiting: true },
      });
    }

    // Claim next batch of pending videos
    const { data: batch } = await admin
      .from('job_videos')
      .select('id, video_id')
      .eq('job_id', job_id)
      .eq('transcript_status', 'pending')
      .lt('transcript_retry_count', MAX_RETRIES)
      .order('discovery_position', { ascending: true })
      .limit(BATCH_SIZE);

    if (!batch || batch.length === 0) {
      // Pending disappeared between count and select (race) — return remaining
      return NextResponse.json<ApiResponse>({
        success: true,
        data: { processed: 0, remaining: (currentProcessing ?? 0) },
      });
    }

    // Mark batch as processing
    await admin
      .from('job_videos')
      .update({
        transcript_status: 'processing',
        transcript_attempted_at: new Date().toISOString(),
      })
      .in('id', batch.map(v => v.id));

    // Dispatch all in parallel — fire and forget per video
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
    await Promise.allSettled(
      batch.map(video =>
        fetch(`${baseUrl}/api/worker/extract`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ job_id, job_video_id: video.id, video_id: video.video_id }),
        })
      )
    );

    // After batch completes, count what is TRULY still outstanding
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

    const remaining = (pendingAfter ?? 0) + (processingAfter ?? 0);

    return NextResponse.json<ApiResponse>({
      success: true,
      data: { processed: batch.length, remaining },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Pump failed';
    return NextResponse.json<ApiResponse>({ success: false, error: message }, { status: 500 });
  }
}
