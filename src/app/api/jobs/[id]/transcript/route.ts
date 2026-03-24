import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import type { ApiResponse } from '@/types';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const url = new URL(req.url);
  const videoId = url.searchParams.get('video_id');

  if (!videoId) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'video_id is required' }, { status: 400 });
  }

  // Auth check
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const admin = createAdminClient();

  // Verify job ownership
  const { data: job } = await admin
    .from('jobs')
    .select('id, user_id')
    .eq('id', id)
    .single();

  if (!job || job.user_id !== user.id) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Not found' }, { status: 404 });
  }

  // Get the transcript_storage_path from job_videos
  const { data: video } = await admin
    .from('job_videos')
    .select('transcript_storage_path, video_title, transcript_word_count, transcript_language')
    .eq('job_id', id)
    .eq('video_id', videoId)
    .single();

  if (!video || !video.transcript_storage_path) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Transcript not found' }, { status: 404 });
  }

  // Path stored as "transcripts/{job_id}/{video_id}/transcript.txt" — strip bucket prefix
  const storagePath = (video.transcript_storage_path as string).replace(/^transcripts\//, '');

  const { data: fileData, error: storageErr } = await admin
    .storage
    .from('transcripts')
    .download(storagePath);

  if (storageErr || !fileData) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Failed to load transcript file' }, { status: 500 });
  }

  const text = await fileData.text();

  return NextResponse.json<ApiResponse>({
    success: true,
    data: {
      text,
      title: video.video_title,
      word_count: video.transcript_word_count,
      language: video.transcript_language,
    },
  });
}
