import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import type { ApiResponse } from '@/types';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const admin = createAdminClient();

  try {
    const userClient = await createClient();
    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) {
      return NextResponse.json<ApiResponse>({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const { master_prompt } = body;

    if (!master_prompt || typeof master_prompt !== 'string' || master_prompt.trim().length === 0) {
      return NextResponse.json<ApiResponse>({ success: false, error: 'master_prompt is required' }, { status: 400 });
    }

    if (master_prompt.length > 2000) {
      return NextResponse.json<ApiResponse>({ success: false, error: 'Prompt must be under 2000 characters' }, { status: 400 });
    }

    const { data: job, error: jobError } = await admin
      .from('jobs')
      .select('*')
      .eq('id', id)
      .eq('user_id', user.id)
      .single();

    if (jobError || !job) {
      return NextResponse.json<ApiResponse>({ success: false, error: 'Job not found' }, { status: 404 });
    }

    if (job.status !== 'awaiting_prompt') {
      return NextResponse.json<ApiResponse>({
        success: false,
        error: `Job is not awaiting a prompt (current status: ${job.status})`
      }, { status: 400 });
    }

    // Queue all successfully extracted videos for rewriting
    const { error: updateVideosError } = await admin
      .from('job_videos')
      .update({ rewrite_status: 'queued' })
      .eq('job_id', id)
      .eq('transcript_status', 'done');

    if (updateVideosError) {
      return NextResponse.json<ApiResponse>({ success: false, error: 'Failed to queue videos' }, { status: 500 });
    }

    // Count queued videos
    const { count } = await admin
      .from('job_videos')
      .select('*', { count: 'exact', head: true })
      .eq('job_id', id)
      .eq('rewrite_status', 'queued');

    // Update job
    await admin.from('jobs').update({
      master_prompt: master_prompt.trim(),
      prompt_submitted_at: new Date().toISOString(),
      status: 'rewriting',
    }).eq('id', id);

    return NextResponse.json<ApiResponse>({
      success: true,
      data: { queued_count: count ?? 0 }
    });

  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to submit prompt';
    return NextResponse.json<ApiResponse>({ success: false, error: message }, { status: 500 });
  }
}
