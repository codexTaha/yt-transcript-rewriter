/**
 * POST /api/worker/rewrite
 * Per-video AI rewrite worker.
 *
 * On 429 rate-limit: sets rewrite_status='queued' with exponential backoff delay
 * so the pump doesn't immediately re-dispatch and hammer the API.
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { rewriteWithAI } from '@/lib/ai/client';
import { chunkTranscript, mergeChunks } from '@/lib/ai/chunker';
import { sanitizeModelId } from '@/lib/ai/models';
import type { ApiResponse } from '@/types';

export const maxDuration = 60;

// Exponential backoff delays by retry count (ms).
// retry 0 → 15s, retry 1 → 60s, retry 2 → 120s, then permanent fail
const BACKOFF_MS = [15_000, 60_000, 120_000];

export async function POST(req: NextRequest) {
  const admin = createAdminClient();

  let job_video_id: string | undefined;
  let job_id:       string | undefined;

  try {
    const body = await req.json() as { job_id: string; job_video_id: string; video_id: string };
    job_video_id = body.job_video_id;
    job_id       = body.job_id;
    const video_id = body.video_id;

    if (!job_video_id || !job_id || !video_id) {
      return NextResponse.json<ApiResponse>(
        { success: false, error: 'Missing required fields' },
        { status: 400 }
      );
    }

    const { data: job } = await admin
      .from('jobs')
      .select('status, master_prompt, ai_model')
      .eq('id', job_id)
      .single();

    if (!job || job.status === 'cancelled') {
      await admin.from('job_videos')
        .update({ rewrite_status: 'failed', rewrite_error: 'Job cancelled or not found' })
        .eq('id', job_video_id);
      return NextResponse.json<ApiResponse>({ success: false, error: 'Job cancelled' }, { status: 409 });
    }

    if (!job.master_prompt) {
      await admin.from('job_videos')
        .update({ rewrite_status: 'failed', rewrite_error: 'No master prompt set' })
        .eq('id', job_video_id);
      return NextResponse.json<ApiResponse>({ success: false, error: 'No master prompt' }, { status: 400 });
    }

    const { data: videoRow } = await admin
      .from('job_videos')
      .select('transcript_storage_path, video_title, rewrite_retry_count')
      .eq('id', job_video_id)
      .single();

    if (!videoRow?.transcript_storage_path) {
      await admin.from('job_videos')
        .update({ rewrite_status: 'failed', rewrite_error: 'No transcript path on video row' })
        .eq('id', job_video_id);
      return NextResponse.json<ApiResponse>({ success: false, error: 'No transcript path' }, { status: 422 });
    }

    const downloadPath = videoRow.transcript_storage_path.replace(/^transcripts\//, '');
    const { data: fileData, error: downloadError } = await admin
      .storage.from('transcripts').download(downloadPath);

    if (downloadError || !fileData) {
      const errMsg = `Transcript download failed: ${downloadError?.message ?? 'no data'}`;
      await admin.from('job_videos')
        .update({ rewrite_status: 'failed', rewrite_error: errMsg })
        .eq('id', job_video_id);
      return NextResponse.json<ApiResponse>({ success: false, error: errMsg }, { status: 500 });
    }

    const transcriptText = await fileData.text();
    if (!transcriptText.trim()) {
      await admin.from('job_videos')
        .update({ rewrite_status: 'failed', rewrite_error: 'Transcript file is empty' })
        .eq('id', job_video_id);
      return NextResponse.json<ApiResponse>({ success: false, error: 'Empty transcript' }, { status: 422 });
    }

    // sanitizeModelId substitutes any stale/unknown model ID from old DB rows
    // (e.g. mistralai/mistral-7b-instruct:free) with the current default.
    const rawModel = (job.ai_model as string | null) ?? process.env.AI_MODEL ?? null;
    const model    = sanitizeModelId(rawModel);

    if (rawModel !== model) {
      console.log(`[rewrite worker] stale model "${rawModel ?? 'null'}" → replaced with "${model}"`);
      // Persist the corrected model so subsequent retries use the right one
      await admin.from('jobs').update({ ai_model: model }).eq('id', job_id);
    }

    const chunks = chunkTranscript(transcriptText);
    const rewrittenParts: string[] = [];

    for (let i = 0; i < chunks.length; i++) {
      const userContent = chunks.length > 1
        ? `[Part ${i + 1} of ${chunks.length}]\n\n${chunks[i]}`
        : chunks[i];
      const part = await rewriteWithAI({ systemPrompt: job.master_prompt as string, userContent, model });
      rewrittenParts.push(part);
    }

    const rewrittenText = mergeChunks(rewrittenParts);
    if (!rewrittenText.trim()) throw new Error('AI returned empty rewritten text');

    const rewrittenPath = `${job_id}/${video_id}/rewritten.txt`;
    const { error: uploadError } = await admin
      .storage.from('transcripts')
      .upload(rewrittenPath, rewrittenText, { contentType: 'text/plain', upsert: true });

    if (uploadError) throw new Error(`Storage upload failed: ${uploadError.message}`);

    await admin.from('job_videos').update({
      rewrite_status:         'done',
      rewritten_storage_path: `transcripts/${rewrittenPath}`,
      rewrite_model_used:     model,
      rewrite_chunk_count:    chunks.length,
      rewrite_error:          null,
      rewrite_completed_at:   new Date().toISOString(),
    }).eq('id', job_video_id);

    return NextResponse.json<ApiResponse>({ success: true, data: { video_id, chunks: chunks.length, model } });

  } catch (err) {
    const message = err instanceof Error ? err.message : 'Rewrite failed';
    console.error('[rewrite worker] fatal:', message);

    if (job_video_id) {
      try {
        const { data: current } = await admin
          .from('job_videos')
          .select('rewrite_retry_count')
          .eq('id', job_video_id)
          .single();

        const retryCount = (current?.rewrite_retry_count ?? 0) + 1;
        const is429      = message.includes('429');

        if (retryCount >= 3 || !is429) {
          await admin.from('job_videos').update({
            rewrite_status:      'failed',
            rewrite_error:       message,
            rewrite_retry_count: retryCount,
          }).eq('id', job_video_id);
        } else {
          const backoffMs = BACKOFF_MS[retryCount - 1] ?? 120_000;
          const notBefore = new Date(Date.now() + backoffMs).toISOString();
          await admin.from('job_videos').update({
            rewrite_status:      'queued',
            rewrite_error:       message,
            rewrite_retry_count: retryCount,
            rewrite_not_before:  notBefore,
          }).eq('id', job_video_id);
          console.log(`[rewrite worker] 429 on ${job_video_id}: backoff ${backoffMs}ms until ${notBefore}`);
        }
      } catch (updateErr) {
        console.error('[rewrite worker] could not update retry status:', updateErr);
      }
    }

    return NextResponse.json<ApiResponse>({ success: false, error: message }, { status: 500 });
  }
}
