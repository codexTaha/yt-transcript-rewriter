import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import { discoverVideos } from '@/lib/youtube/discover';
import { validateYouTubeUrl } from '@/lib/youtube/validate-url';
import type { ApiResponse } from '@/types';

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const admin = createAdminClient();

  try {
    // Auth via user client
    const userClient = await createClient();
    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) {
      return NextResponse.json<ApiResponse>({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    // Fetch the job
    const { data: job, error: jobError } = await admin
      .from('jobs')
      .select('*')
      .eq('id', params.id)
      .eq('user_id', user.id)
      .single();

    if (jobError || !job) {
      return NextResponse.json<ApiResponse>({ success: false, error: 'Job not found' }, { status: 404 });
    }

    // Idempotency: skip if already past discovering
    if (!['created', 'discovering'].includes(job.status)) {
      return NextResponse.json<ApiResponse>({
        success: true,
        data: { message: 'Discovery already completed', video_count: job.total_video_count }
      });
    }

    // Set status to discovering
    await admin
      .from('jobs')
      .update({ status: 'discovering', discovery_started_at: new Date().toISOString() })
      .eq('id', params.id);

    // Validate and run discovery
    const validated = validateYouTubeUrl(job.source_url);
    if (!validated) {
      await admin.from('jobs').update({
        status: 'failed',
        error_message: 'Invalid source URL'
      }).eq('id', params.id);
      return NextResponse.json<ApiResponse>({ success: false, error: 'Invalid source URL' }, { status: 400 });
    }

    const result = await discoverVideos(validated.type, validated.rawId, validated.normalizedUrl);

    if (result.videos.length === 0) {
      await admin.from('jobs').update({
        status: 'failed',
        error_message: 'No videos found for this source.'
      }).eq('id', params.id);
      return NextResponse.json<ApiResponse>({
        success: false,
        error: 'No videos found'
      }, { status: 422 });
    }

    // Bulk insert job_videos rows
    const videoRows = result.videos.map((v) => ({
      job_id: params.id,
      video_id: v.video_id,
      video_title: v.title,
      video_url: `https://www.youtube.com/watch?v=${v.video_id}`,
      channel_name: v.channel_name ?? '',
      duration_seconds: v.duration_seconds ?? 0,
      discovery_position: v.position,
      transcript_status: 'pending' as const,
      rewrite_status: 'not_started' as const,
      transcript_retry_count: 0,
      rewrite_retry_count: 0,
    }));

    const { error: insertError } = await admin
      .from('job_videos')
      .insert(videoRows);

    if (insertError) {
      console.error('[discover] insert job_videos error:', insertError);
      await admin.from('jobs').update({
        status: 'failed',
        error_message: 'Failed to save discovered videos'
      }).eq('id', params.id);
      return NextResponse.json<ApiResponse>({
        success: false,
        error: 'Failed to save discovered videos'
      }, { status: 500 });
    }

    // Update job with discovery results
    await admin.from('jobs').update({
      status: 'extracting',
      source_name: result.source_name,
      source_channel_id: result.source_channel_id ?? null,
      source_playlist_id: result.source_playlist_id ?? null,
      total_video_count: result.videos.length,
      extraction_started_at: new Date().toISOString(),
    }).eq('id', params.id);

    return NextResponse.json<ApiResponse>({
      success: true,
      data: {
        video_count: result.videos.length,
        source_name: result.source_name,
        source_type: result.source_type,
      }
    });

  } catch (err) {
    console.error('[discover] error:', err);
    const message = err instanceof Error ? err.message : 'Discovery failed';

    await admin.from('jobs').update({
      status: 'failed',
      error_message: message
    }).eq('id', params.id).catch(() => {});

    return NextResponse.json<ApiResponse>({
      success: false,
      error: message
    }, { status: 500 });
  }
}
