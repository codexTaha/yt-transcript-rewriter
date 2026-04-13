import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import type { ApiResponse } from '@/types';

/**
 * GET /api/jobs/[id]/export-transcripts?format=txt|md
 *
 * format=txt (default): plain text bundle, one file per video separated by dividers.
 * format=md: Markdown bundle — each video gets a # heading, video URL link,
 *            word count, and transcript under a ## Transcript heading.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const format = (req.nextUrl.searchParams.get('format') ?? 'txt') as 'txt' | 'md';

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

  // Helper to download a single transcript text from Supabase storage
  async function fetchTranscriptText(storagePath: string): Promise<string> {
    const downloadPath = storagePath.startsWith('transcripts/')
      ? storagePath.slice('transcripts/'.length)
      : storagePath;
    const { data: fileData, error: dlErr } = await admin
      .storage
      .from('transcripts')
      .download(downloadPath);
    if (dlErr || !fileData) return '(transcript content unavailable)';
    return (await fileData.text()).trim();
  }

  let bundle: string;
  let filename: string;
  let contentType: string;

  if (format === 'md') {
    // ─── Markdown format ───
    const sourceName = (job.source_name as string | null) ?? (job.source_url as string);
    const lines: string[] = [
      `# Transcripts: ${sourceName}`,
      ``,
      `> **Source:** [${job.source_url as string}](${job.source_url as string})  `,
      `> **Videos:** ${videos.length}  `,
      `> **Exported:** ${new Date().toUTCString()}`,
      ``,
      `---`,
      ``,
    ];

    for (let i = 0; i < videos.length; i++) {
      const v     = videos[i];
      const title = (v.video_title as string | null) ?? (v.video_id as string);
      const words = v.transcript_word_count
        ? `${(v.transcript_word_count as number).toLocaleString()} words`
        : null;
      const videoUrl = `https://www.youtube.com/watch?v=${v.video_id as string}`;

      lines.push(
        `## ${i + 1}. ${title}`,
        ``,
        `**URL:** [${videoUrl}](${videoUrl})${ words ? `  ` : `` }`,
        ...(words ? [`**Words:** ${words}`, ``] : [``]),
        `### Transcript`,
        ``,
      );

      const text = await fetchTranscriptText(v.transcript_storage_path as string);
      lines.push(text, ``, `---`, ``);
    }

    bundle      = lines.join('\n');
    filename    = `transcripts-${id.slice(0, 8)}.md`;
    contentType = 'text/markdown; charset=utf-8';

  } else {
    // ─── Plain text format (default) ───
    const lines: string[] = [
      `YT Rewriter — Raw Transcript Export`,
      `Source : ${(job.source_name as string | null) ?? (job.source_url as string)}`,
      `URL    : ${job.source_url as string}`,
      `Videos : ${videos.length}`,
      `Date   : ${new Date().toUTCString()}`,
      ``,
      `${'='.repeat(80)}`,
      ``,
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
        ``,
      );

      const text = await fetchTranscriptText(v.transcript_storage_path as string);
      lines.push(text, ``, `${'-'.repeat(80)}`, ``);
    }

    bundle      = lines.join('\n');
    filename    = `transcripts-${id.slice(0, 8)}.txt`;
    contentType = 'text/plain; charset=utf-8';
  }

  return new NextResponse(bundle, {
    status: 200,
    headers: {
      'Content-Type':        contentType,
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length':      String(Buffer.byteLength(bundle, 'utf8')),
    },
  });
}
