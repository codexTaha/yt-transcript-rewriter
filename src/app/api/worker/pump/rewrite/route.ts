import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import type { ApiResponse } from '@/types';

// OpenRouter free tier supports concurrent requests — 5 parallel is safe.
// Each request is fire-and-forget; the pump returns immediately and the
// client poller re-triggers it every few seconds to pick up the next batch.
const BATCH_SIZE = 5;
const MAX_RETRIES = 3;
const PROCESSING_STALE_MS = 90_000;

export async function POST(req: NextRequest) {
  const admin = createAdminClient();

  try {
    const body = await req.json();
    const { job_id } = body;

    if (!job_id) {
      return NextResponse.json<ApiResponse>({ success: false, error: 'job_id is required' }, { status: 400 });
    }

    const { data: job } = await admin
      .from('jobs').select('status, master_prompt, ai_model').eq('id', job_id).single();

    if (!job || !['rewriting', 'queued_for_rewrite'].includes(job.status)) {
      return NextResponse.json<ApiResponse>({
        success: true,
        data: { processed: 0, remaining: 0, message: 'Job not in rewriting state' },
      });
    }

    // --- Unstick stale processing rows ---
    const staleThreshold = new Date(Date.now() - PROCESSING_STALE_MS).toISOString();
    await admin
      .from('job_videos')
      .update({ rewrite_status: 'queued', rewrite_not_before: null })
      .eq('job_id', job_id)
      .eq('rewrite_status', 'processing')
      .lt('rewrite_attempted_at', staleThreshold);

    const now = new Date().toISOString();

    const { count: currentQueued } = await admin
      .from('job_videos').select('*', { count: 'exact', head: true })
      .eq('job_id', job_id).eq('rewrite_status', 'queued')
      .lt('rewrite_retry_count', MAX_RETRIES)
      .or(`rewrite_not_before.is.null,rewrite_not_before.lte.${now}`);

    const { count: currentProcessing } = await admin
      .from('job_videos').select('*', { count: 'exact', head: true })
      .eq('job_id', job_id).eq('rewrite_status', 'processing');

    const { count: inBackoff } = await admin
      .from('job_videos').select('*', { count: 'exact', head: true })
      .eq('job_id', job_id).eq('rewrite_status', 'queued')
      .not('rewrite_not_before', 'is', null).gt('rewrite_not_before', now);

    // --- All done? Advance job ---
    if ((currentQueued ?? 0) === 0 && (currentProcessing ?? 0) === 0) {
      if ((inBackoff ?? 0) > 0) {
        return NextResponse.json<ApiResponse>({
          success: true,
          data: { processed: 0, remaining: inBackoff ?? 0, waiting: true, message: 'Rate-limit backoff' },
        });
      }

      const { count: successCount } = await admin
        .from('job_videos').select('*', { count: 'exact', head: true })
        .eq('job_id', job_id).eq('rewrite_status', 'done');

      const { count: failedCount } = await admin
        .from('job_videos').select('*', { count: 'exact', head: true })
        .eq('job_id', job_id).eq('rewrite_status', 'failed');

      await admin.from('jobs').update({
        status: 'building_export',
        rewrite_success_count: successCount ?? 0,
        rewrite_failed_count:  failedCount  ?? 0,
      }).eq('id', job_id).in('status', ['rewriting', 'queued_for_rewrite']);

      const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
      fetch(`${baseUrl}/api/jobs/${job_id}/export`, { method: 'POST' }).catch(() => {});

      return NextResponse.json<ApiResponse>({
        success: true,
        data: { processed: 0, remaining: 0, advanced: true, next_status: 'building_export' },
      });
    }

    // --- Throttle: already at batch capacity ---
    if ((currentProcessing ?? 0) >= BATCH_SIZE) {
      return NextResponse.json<ApiResponse>({
        success: true,
        data: { processed: 0, remaining: (currentQueued ?? 0) + (currentProcessing ?? 0), waiting: true },
      });
    }

    // --- Nothing ready (all in backoff) ---
    if ((currentQueued ?? 0) === 0) {
      return NextResponse.json<ApiResponse>({
        success: true,
        data: { processed: 0, remaining: (inBackoff ?? 0) + (currentProcessing ?? 0), waiting: true },
      });
    }

    // --- Dispatch next batch (fill up to BATCH_SIZE slots) ---
    const slots = BATCH_SIZE - (currentProcessing ?? 0);
    const { data: batch } = await admin
      .from('job_videos').select('id, video_id')
      .eq('job_id', job_id).eq('rewrite_status', 'queued')
      .lt('rewrite_retry_count', MAX_RETRIES)
      .or(`rewrite_not_before.is.null,rewrite_not_before.lte.${now}`)
      .order('discovery_position', { ascending: true })
      .limit(slots);

    if (!batch || batch.length === 0) {
      return NextResponse.json<ApiResponse>({
        success: true,
        data: { processed: 0, remaining: (currentProcessing ?? 0) + (inBackoff ?? 0), waiting: true },
      });
    }

    // Mark as processing BEFORE firing requests
    await admin.from('job_videos').update({
      rewrite_status:       'processing',
      rewrite_attempted_at: new Date().toISOString(),
      rewrite_not_before:   null,
    }).in('id', batch.map((v: { id: string }) => v.id));

    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

    // Fire-and-forget — all BATCH_SIZE run in parallel
    batch.forEach((video: { id: string; video_id: string }) => {
      fetch(`${baseUrl}/api/worker/rewrite`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ job_id, job_video_id: video.id, video_id: video.video_id }),
      }).catch(() => {});
    });

    const { count: queuedAfter } = await admin
      .from('job_videos').select('*', { count: 'exact', head: true })
      .eq('job_id', job_id).eq('rewrite_status', 'queued');

    return NextResponse.json<ApiResponse>({
      success: true,
      data: { processed: batch.length, remaining: (queuedAfter ?? 0) + batch.length },
    });

  } catch (err) {
    const message = err instanceof Error ? err.message : 'Rewrite pump failed';
    return NextResponse.json<ApiResponse>({ success: false, error: message }, { status: 500 });
  }
}
