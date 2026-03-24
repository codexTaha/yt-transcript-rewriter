/**
 * POST /api/worker/pump/rewrite
 *
 * Free-tier OpenRouter rate limits are very tight (~20 RPM per model, shared
 * across all users globally). Running 2 parallel workers × 4 fallback models
 * means up to 8 API calls per poll cycle, which exhausts every free endpoint
 * simultaneously and causes an endless 429 spiral.
 *
 * Strategy:
 *   - BATCH_SIZE = 1:  only one video rewriting at a time
 *   - MIN_DISPATCH_GAP_MS: pump will not dispatch a new video if the last
 *     dispatch happened less than this many ms ago. The client polls every
 *     ~2 s, so this effectively rate-gates the whole pipeline.
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import type { ApiResponse } from '@/types';

const BATCH_SIZE           = 1;
const MAX_RETRIES          = 3;
const PROCESSING_STALE_MS  = 120_000;  // 2 min before a stuck "processing" row is recycled
const MIN_DISPATCH_GAP_MS  = 8_000;    // wait at least 8 s between dispatches

// Module-level last-dispatch timestamp (per process / serverless instance).
// Resets on cold start, which is fine — cold starts mean idle periods anyway.
let lastDispatchAt = 0;

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

    // Unstick stale processing rows
    const staleThreshold = new Date(Date.now() - PROCESSING_STALE_MS).toISOString();
    await admin.from('job_videos')
      .update({ rewrite_status: 'queued', rewrite_not_before: null })
      .eq('job_id', job_id).eq('rewrite_status', 'processing')
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

    // All done? Advance job to export
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

    // Already at batch capacity
    if ((currentProcessing ?? 0) >= BATCH_SIZE) {
      return NextResponse.json<ApiResponse>({
        success: true,
        data: { processed: 0, remaining: (currentQueued ?? 0) + (currentProcessing ?? 0), waiting: true },
      });
    }

    // Nothing ready (all in backoff)
    if ((currentQueued ?? 0) === 0) {
      return NextResponse.json<ApiResponse>({
        success: true,
        data: { processed: 0, remaining: (inBackoff ?? 0) + (currentProcessing ?? 0), waiting: true },
      });
    }

    // Rate-gate: don't dispatch a new video until MIN_DISPATCH_GAP_MS has passed
    const msSinceLast = Date.now() - lastDispatchAt;
    if (msSinceLast < MIN_DISPATCH_GAP_MS) {
      return NextResponse.json<ApiResponse>({
        success: true,
        data: {
          processed: 0,
          remaining: (currentQueued ?? 0) + (currentProcessing ?? 0),
          waiting:   true,
          message:   `Dispatch gap: ${Math.ceil((MIN_DISPATCH_GAP_MS - msSinceLast) / 1000)}s remaining`,
        },
      });
    }

    // Dispatch next single video
    const { data: batch } = await admin
      .from('job_videos').select('id, video_id')
      .eq('job_id', job_id).eq('rewrite_status', 'queued')
      .lt('rewrite_retry_count', MAX_RETRIES)
      .or(`rewrite_not_before.is.null,rewrite_not_before.lte.${now}`)
      .order('discovery_position', { ascending: true })
      .limit(BATCH_SIZE);

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

    lastDispatchAt = Date.now();

    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
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
