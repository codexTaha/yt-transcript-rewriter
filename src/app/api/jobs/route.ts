import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { validateYouTubeUrl } from '@/lib/youtube/validate-url';
import type { ApiResponse } from '@/types';

export async function POST(req: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json<ApiResponse>({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const { source_url, filter_min_duration_hours } = body;

    if (!source_url || typeof source_url !== 'string') {
      return NextResponse.json<ApiResponse>({ success: false, error: 'source_url is required' }, { status: 400 });
    }

    const validated = validateYouTubeUrl(source_url);
    if (!validated) {
      return NextResponse.json<ApiResponse>({ success: false, error: 'Invalid YouTube URL.' }, { status: 400 });
    }

    const minDurationSec = filter_min_duration_hours
      ? Math.round(parseFloat(filter_min_duration_hours) * 3600)
      : null;

    const { data: job, error: insertError } = await supabase
      .from('jobs')
      .insert({
        user_id:    user.id,
        source_url: validated.normalizedUrl,
        source_type: validated.type,
        status: 'created',
        ai_provider: process.env.AI_PROVIDER ?? 'openrouter',
        ai_model:    process.env.AI_MODEL    ?? 'google/gemini-2.5-flash-preview:free',
        filter_min_duration_sec: minDurationSec,
        total_video_count: 0,
        transcript_success_count: 0,
        transcript_failed_count:  0,
        rewrite_success_count:    0,
        rewrite_failed_count:     0,
        export_ready: false,
      })
      .select('id')
      .single();

    if (insertError || !job) {
      console.error('[jobs POST] insert error:', insertError);
      return NextResponse.json<ApiResponse>({ success: false, error: 'Failed to create job' }, { status: 500 });
    }

    return NextResponse.json<ApiResponse<{ job_id: string; source_type: string }>>(
      { success: true, data: { job_id: job.id, source_type: validated.type } },
      { status: 201 }
    );
  } catch (err) {
    console.error('[jobs POST] unexpected error:', err);
    return NextResponse.json<ApiResponse>({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}

export async function GET(_req: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json<ApiResponse>({ success: false, error: 'Unauthorized' }, { status: 401 });
    }
    const { data: jobs, error } = await supabase
      .from('jobs').select('*').eq('user_id', user.id)
      .order('created_at', { ascending: false }).limit(50);
    if (error) return NextResponse.json<ApiResponse>({ success: false, error: error.message }, { status: 500 });
    return NextResponse.json<ApiResponse>({ success: true, data: jobs });
  } catch {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}
