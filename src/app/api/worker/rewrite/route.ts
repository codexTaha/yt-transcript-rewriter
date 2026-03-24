import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import type { ApiResponse } from '@/types';

const MAX_TOKENS = 4096;
const CHUNK_WORDS = 2500;

// ── Helpers ────────────────────────────────────────────────────────────────

function chunkText(text: string, maxWords = CHUNK_WORDS): string[] {
  const words = text.split(/\s+/);
  if (words.length <= maxWords) return [text];
  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += maxWords) {
    chunks.push(words.slice(i, i + maxWords).join(' '));
  }
  return chunks;
}

async function callAI(
  systemPrompt: string,
  userContent: string,
  model: string,
  baseUrl: string,
  apiKey: string
): Promise<string> {
  const res = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: MAX_TOKENS,
      messages: [{ role: 'user', content: userContent }],
      system: systemPrompt,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`AI API error ${res.status}: ${errText.slice(0, 300)}`);
  }

  const data = await res.json() as {
    content?: Array<{ type: string; text?: string }>;
    error?: { message: string };
  };

  if (data.error) throw new Error(`AI error: ${data.error.message}`);

  const text = data.content?.find(b => b.type === 'text')?.text;
  if (!text) throw new Error('AI returned no text content');
  return text;
}

// ── Route ──────────────────────────────────────────────────────────────────

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const admin = createAdminClient();

  let job_video_id: string | undefined;
  let job_id: string | undefined;

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

    // Load job (need master_prompt + model)
    const { data: job } = await admin
      .from('jobs')
      .select('status, master_prompt, ai_model')
      .eq('id', job_id)
      .single();

    if (!job || job.status === 'cancelled') {
      await admin.from('job_videos').update({ rewrite_status: 'failed', rewrite_error: 'Job cancelled or not found' }).eq('id', job_video_id);
      return NextResponse.json<ApiResponse>({ success: false, error: 'Job cancelled' }, { status: 409 });
    }

    if (!job.master_prompt) {
      await admin.from('job_videos').update({ rewrite_status: 'failed', rewrite_error: 'No master prompt set' }).eq('id', job_video_id);
      return NextResponse.json<ApiResponse>({ success: false, error: 'No master prompt' }, { status: 400 });
    }

    // Load video row to get transcript storage path
    const { data: videoRow } = await admin
      .from('job_videos')
      .select('transcript_storage_path, video_title')
      .eq('id', job_video_id)
      .single();

    if (!videoRow?.transcript_storage_path) {
      await admin.from('job_videos').update({ rewrite_status: 'failed', rewrite_error: 'No transcript path' }).eq('id', job_video_id);
      return NextResponse.json<ApiResponse>({ success: false, error: 'No transcript path' }, { status: 422 });
    }

    // Download original transcript from storage
    // transcript_storage_path is stored as "transcripts/{job_id}/{video_id}/transcript.txt"
    // The storage.from('transcripts').download() needs the path WITHOUT the bucket prefix
    const storagePath = videoRow.transcript_storage_path.replace(/^transcripts\//, '');

    const { data: fileData, error: downloadError } = await admin
      .storage
      .from('transcripts')
      .download(storagePath);

    if (downloadError || !fileData) {
      const errMsg = `Failed to download transcript: ${downloadError?.message ?? 'no data'}`;
      await admin.from('job_videos').update({ rewrite_status: 'failed', rewrite_error: errMsg }).eq('id', job_video_id);
      return NextResponse.json<ApiResponse>({ success: false, error: errMsg }, { status: 500 });
    }

    const transcriptText = await fileData.text();
    if (!transcriptText.trim()) {
      await admin.from('job_videos').update({ rewrite_status: 'failed', rewrite_error: 'Empty transcript' }).eq('id', job_video_id);
      return NextResponse.json<ApiResponse>({ success: false, error: 'Empty transcript' }, { status: 422 });
    }

    // AI config from env
    const apiKey  = process.env.ANTHROPIC_API_KEY ?? '';
    const baseUrl = (process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com').replace(/\/$/, '');
    const model   = (job.ai_model as string | null) ?? process.env.AI_MODEL ?? 'claude-3-5-sonnet-20241022';

    if (!apiKey) {
      const errMsg = 'ANTHROPIC_API_KEY not set';
      await admin.from('job_videos').update({ rewrite_status: 'failed', rewrite_error: errMsg }).eq('id', job_video_id);
      return NextResponse.json<ApiResponse>({ success: false, error: errMsg }, { status: 500 });
    }

    // Chunk if needed and rewrite
    const chunks = chunkText(transcriptText);
    const rewrittenParts: string[] = [];

    for (let i = 0; i < chunks.length; i++) {
      const userContent = chunks.length > 1
        ? `[Part ${i + 1} of ${chunks.length}]\n\n${chunks[i]}`
        : chunks[i];

      const part = await callAI(
        job.master_prompt as string,
        userContent,
        model,
        baseUrl,
        apiKey
      );
      rewrittenParts.push(part);
    }

    const rewrittenText = rewrittenParts.join('\n\n---\n\n');

    // Upload rewritten text — store in transcripts bucket under rewritten path
    const rewrittenPath = `${job_id}/${video_id}/rewritten.txt`;
    const { error: uploadError } = await admin
      .storage
      .from('transcripts')
      .upload(rewrittenPath, rewrittenText, { contentType: 'text/plain', upsert: true });

    if (uploadError) throw new Error(`Rewritten upload failed: ${uploadError.message}`);

    await admin
      .from('job_videos')
      .update({
        rewrite_status: 'done',
        rewritten_storage_path: `transcripts/${rewrittenPath}`,
        rewrite_model_used: model,
        rewrite_chunk_count: chunks.length,
        rewrite_error: null,
        rewrite_completed_at: new Date().toISOString(),
      })
      .eq('id', job_video_id);

    return NextResponse.json<ApiResponse>({
      success: true,
      data: { video_id, chunks: chunks.length, model },
    });

  } catch (err) {
    const message = err instanceof Error ? err.message : 'Rewrite failed';
    console.error('[rewrite worker] fatal:', message);

    if (job_video_id) {
      const { data: current } = await admin
        .from('job_videos')
        .select('rewrite_retry_count')
        .eq('id', job_video_id)
        .single();

      const retryCount = (current?.rewrite_retry_count ?? 0) + 1;
      const newStatus  = retryCount >= 3 ? 'failed' : 'queued';

      await admin
        .from('job_videos')
        .update({
          rewrite_status: newStatus,
          rewrite_error: message,
          rewrite_retry_count: retryCount,
        })
        .eq('id', job_video_id)
        .catch(() => {});
    }

    return NextResponse.json<ApiResponse>(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
