import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import type { ApiResponse } from '@/types';

/**
 * GET /api/jobs/[id]/export-transcripts
 * Streams back a single .txt file with all transcripts bundled,
 * separated by video title headings and dividers.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Auth
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const admin = createAdminClient();

  // Ownership check
  const { data: job } = await admin
    .from('jobs')
    .select('id, user_id, source_name, source_url')
    .eq('id', id)
    .single();

  if (!job || job.user_id !== user.id) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Not found' }, { status: 404 });
  }

  // Fetch all videos that have a transcript
  const { data: videos } = await admin
    .from('job_videos')
    .select('video_id, video_title, transcript_storage_path, transcript_word_count')
    .eq('job_id', id)
    .eq('transcript_status', 'done')
    .order('discovery_position', { ascending: true });

  if (!videos || videos.length === 0) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'No transcripts available' }, { status: 422 });
  }

  // Build the .txt bundle
  const lines: string[] = [
    `YT Rewriter — Transcript Export`,
    `Source : ${job.source_name ?? job.source_url}`,
    `URL    : ${job.source_url}`,
    `Videos : ${videos.length}`,
    `Date   : ${new Date().toUTCString()}`,
    '',
    '='.repeat(80),
    '',
  ];

  for (let i = 0; i < videos.length; i++) {
    const v = videos[i];
    const title   = (v.video_title as string | null) ?? (v.video_id as string);
    const wordCnt = v.transcript_word_count ? ` (${(v.transcript_word_count as number).toLocaleString()} words)` : '';

    lines.push(`[${i + 1}] ${title}${wordCnt}`);
    lines.push(`    https://www.youtube.com/watch?v=${v.video_id as string}`);
    lines.push('');

    // Fetch transcript text from storage
    const rawPath = (v.transcript_storage_path as string).replace(/^transcripts\//, '');
    const { data: fileData } = await admin
      .storage
      .from('transcripts')
      .download(rawPath);

    const text = fileData ? await fileData.text() : '(transcript unavailable)';
    lines.push(text.trim());
    lines.push('');
    lines.push('-'.repeat(80));
    lines.push('');
  }

  const bundle = lines.join('\n');
  const filename = `transcripts-${id.slice(0, 8)}.txt`;

  return new NextResponse(bundle, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': String(Buffer.byteLength(bundle, 'utf8')),
    },
  });
}
