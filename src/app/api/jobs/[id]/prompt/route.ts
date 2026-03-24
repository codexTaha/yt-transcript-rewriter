/**
 * POST /api/jobs/[id]/prompt
 * Accepts master_prompt + optional ai_model override.
 * If ai_model is provided it overwrites the job row so every rewrite
 * worker picks up the user-chosen model.
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import { DEFAULT_MODEL } from '@/lib/ai/models';
import type { ApiResponse } from '@/types';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const admin  = createAdminClient();

  try {
    const userClient = await createClient();
    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) {
      return NextResponse.json<ApiResponse>({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const { master_prompt, ai_model } = body;

    if (!master_prompt || typeof master_prompt !== 'string' || master_prompt.trim().length === 0) {
      return NextResponse.json<ApiResponse>({ success: false, error: 'master_prompt is required' }, { status: 400 });
    }
    if (master_prompt.length > 2000) {
      return NextResponse.json<ApiResponse>({ success: false, error: 'Prompt must be under 2000 characters' }, { status: 400 });
    }

    const { data: job, error: jobError } = await admin
      .from('jobs').select('*').eq('id', id).eq('user_id', user.id).single();
    if (jobError || !job) {
      return NextResponse.json<ApiResponse>({ success: false, error: 'Job not found' }, { status: 404 });
    }
    if (job.status !== 'awaiting_prompt') {
      return NextResponse.json<ApiResponse>({
        success: false,
        error: `Job is not awaiting a prompt (status: ${job.status})`,
      }, { status: 400 });
    }

    // Queue all successfully extracted videos
    const { error: updateVideosError } = await admin
      .from('job_videos')
      .update({ rewrite_status: 'queued' })
      .eq('job_id', id)
      .eq('transcript_status', 'done');
    if (updateVideosError) {
      return NextResponse.json<ApiResponse>({ success: false, error: 'Failed to queue videos' }, { status: 500 });
    }

    const { count } = await admin
      .from('job_videos').select('*', { count: 'exact', head: true })
      .eq('job_id', id).eq('rewrite_status', 'queued');

    // Always write the chosen/default model back to the job row so workers
    // pick up the correct model regardless of what was stored previously.
    const resolvedModel = (typeof ai_model === 'string' && ai_model.trim())
      ? ai_model.trim()
      : (process.env.AI_MODEL ?? DEFAULT_MODEL);

    await admin.from('jobs').update({
      master_prompt:       master_prompt.trim(),
      ai_model:            resolvedModel,
      prompt_submitted_at: new Date().toISOString(),
      status:              'rewriting',
    }).eq('id', id);

    return NextResponse.json<ApiResponse>({
      success: true,
      data: { queued_count: count ?? 0, ai_model: resolvedModel },
    });

  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to submit prompt';
    return NextResponse.json<ApiResponse>({ success: false, error: message }, { status: 500 });
  }
}
