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
      return NextResponse.json<ApiResponse>({ success: false, error: 'job_id is required' }, { status: 400 });
    }

    // Get job to verify it's in extracting state
    const { data: job } = await admin
      .from('jobs')
      .select('status, total_video_count')
      .eq('id', job_id)
      .single();

    if (!job || job.status !== 'extracting') {
      return NextResponse.json<ApiResponse>({
        success: true,
        data: { processed: 0, remaining: 0, message: 'Job not in extracting state' }
      });
    }

    // Atomically claim next batch of pending videos
    const { data: batch } = await admin
      .from('job_videos')
      .select('id, video_id')
      .eq('job_id', job_id)
      .eq('transcript_status', 'pending')
      .lt('transcript_retry_count', MAX_RETRIES)
      .order('discovery_position', { ascending: true })
      .limit(BATCH_SIZE);

    if (!batch || batch.length === 0) {
      // Check if all videos are done/failed/skipped
      const { count: pendingCount } = await admin
        .from('job_videos')
        .select('*', { count: 'exact', head: true })
        .eq('job_id', job_id)
        .eq('transcript_status', 'pending');

      const { count: processingCount } = await admin
        .from('job_videos')
        .select('*', { count: 'exact', head: true })
        .eq('job_id', job_id)
        .eq('transcript_status', 'processing');

      if ((pendingCount ?? 0) === 0 && (processingCount ?? 0) === 0) {
        // All done — tally results and advance job
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

        await admin.from('jobs').update({
          status: 'awaiting_prompt',
          transcript_success_count: successCount ?? 0,
          transcript_failed_count: failedCount ?? 0,
        }).eq('id', job_id);

        return NextResponse.json<ApiResponse>({
          success: true,
          data: { processed: 0, remaining: 0, advanced: true }
        });
      }

      return NextResponse.json<ApiResponse>({
        success: true,
        data: { processed: 0, remaining: (pendingCount ?? 0) + (processingCount ?? 0) }
      });
    }

    // Mark batch as processing
    const batchIds = batch.map(v => v.id);
    await admin
      .from('job_videos')
      .update({ transcript_status: 'processing', transcript_attempted_at: new Date().toISOString() })
      .in('id', batchIds);

    // Process each video in parallel
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
    const results = await Promise.allSettled(
      batch.map(video =>
        fetch(`${baseUrl}/api/worker/extract`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ job_id, job_video_id: video.id, video_id: video.video_id })
        })
      )
    );

    const processed = results.filter(r => r.status === 'fulfilled').length;

    // Count remaining pending
    const { count: remaining } = await admin
      .from('job_videos')
      .select('*', { count: 'exact', head: true })
      .eq('job_id', job_id)
      .eq('transcript_status', 'pending');

    return NextResponse.json<ApiResponse>({
      success: true,
      data: { processed, remaining: remaining ?? 0 }
    });

  } catch (err) {
    const message = err instanceof Error ? err.message : 'Pump failed';
    return NextResponse.json<ApiResponse>({ success: false, error: message }, { status: 500 });
  }
}
