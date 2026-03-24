import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import type { ApiResponse } from '@/types';

/**
 * GET /api/jobs/[id]/export-transcripts
 * Streams back a single .txt file with all raw transcripts bundled,
 * separated by video title headings and dividers.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const admin = createAdminClient();

  const { data: job } = await admin
    .from('jobs')
    .select('id, user_id, source_name, source_url')
    .eq('id', id)
    .single();

  if (!job || job.user_id !== user.id) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Not found' }, { status: 404 });
  }

  const { data: videos } = await admin
    .from('job_videos')
    .select('video_id, video_title, transcript_storage_path, transcript_word_count')
    .eq('job_id', id)
    .eq('transcript_status', 'done')
    .order('discovery_position', { ascending: true });

  if (!videos || videos.length === 0) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'No transcripts available to export' },
      { status: 422 }
    );
  }

  const lines: string[] = [
    `YT Rewriter — Raw Transcript Export`,
    `Source : ${(job.source_name as string | null) ?? (job.source_url as string)}`,
    `URL    : ${job.source_url as string}`,
    `Videos : ${videos.length}`,
    `Date   : ${new Date().toUTCString()}`,
    '',
    '='.repeat(80),
    '',
  ];

  for (let i = 0; i < videos.length; i++) {
    const v     = videos[i];
    const title = (v.video_title as string | null) ?? (v.video_id as string);
    const words = v.transcript_word_count
      ? ` (${(v.transcript_word_count as number).toLocaleString()} words)`
      : '';

    lines.push(
      `[${i + 1}] ${title}${words}`,
      `    https://www.youtube.com/watch?v=${v.video_id as string}`,
      ''
    );

    // transcript_storage_path = "transcripts/{job_id}/{video_id}/transcript.txt"
    // storage.from('transcripts').download() needs path WITHOUT "transcripts/" prefix
    const storagePath = v.transcript_storage_path as string;
    const downloadPath = storagePath.startsWith('transcripts/')
      ? storagePath.slice('transcripts/'.length)
      : storagePath;

    const { data: fileData, error: dlErr } = await admin
      .storage
      .from('transcripts')
      .download(downloadPath);

    if (dlErr || !fileData) {
      lines.push('(transcript content unavailable)');
    } else {
      const text = await fileData.text();
      lines.push(text.trim());
    }

    lines.push('', '-'.repeat(80), '');
  }

  const bundle   = lines.join('\n');
  const filename = `transcripts-${id.slice(0, 8)}.txt`;

  return new NextResponse(bundle, {
    status: 200,
    headers: {
      'Content-Type':        'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length':      String(Buffer.byteLength(bundle, 'utf8')),
    },
  });
}
