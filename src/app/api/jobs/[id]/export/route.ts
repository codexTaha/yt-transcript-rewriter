import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import type { ApiResponse } from '@/types';

/**
 * POST /api/jobs/[id]/export
 * Assembles the final Markdown bundle from all rewritten transcripts
 * and stores it in the exports bucket.
 *
 * Called automatically by the rewrite pump when all videos are done.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const admin = createAdminClient();

  try {
    const { data: job } = await admin
      .from('jobs')
      .select('*')
      .eq('id', id)
      .single();

    if (!job) {
      return NextResponse.json<ApiResponse>({ success: false, error: 'Job not found' }, { status: 404 });
    }

    // Fetch ALL videos (done + failed) for complete bundle with failure notices
    const { data: allVideos } = await admin
      .from('job_videos')
      .select('*')
      .eq('job_id', id)
      .order('discovery_position', { ascending: true });

    const doneVideos   = (allVideos ?? []).filter(v => v.rewrite_status === 'done');
    const failedVideos = (allVideos ?? []).filter(v => v.rewrite_status === 'failed');

    if (doneVideos.length === 0) {
      await admin.from('jobs').update({
        status: 'failed',
        error_message: 'No successfully rewritten videos to export',
      }).eq('id', id);
      return NextResponse.json<ApiResponse>({ success: false, error: 'Nothing to export' }, { status: 422 });
    }

    // ── Build Markdown bundle ──────────────────────────────────────────────
    const lines: string[] = [
      `# ${job.source_name ?? 'YouTube Transcript Bundle'}`,
      '',
      `**Source:** ${job.source_url}`,
      `**Prompt:** ${job.master_prompt}`,
      `**Generated:** ${new Date().toUTCString()}`,
      `**Rewritten:** ${doneVideos.length} / ${(allVideos ?? []).length} videos`,
      '',
      '---',
      '',
      '## Table of Contents',
      '',
    ];

    // TOC
    for (let i = 0; i < doneVideos.length; i++) {
      const v = doneVideos[i];
      const title  = (v.video_title as string | null) ?? (v.video_id as string);
      const anchor = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      lines.push(`${i + 1}. [${title}](#${anchor})`);
    }

    if (failedVideos.length > 0) {
      lines.push('', `*${failedVideos.length} video(s) failed rewriting — listed at the end.*`);
    }

    lines.push('', '---', '');

    // Content sections
    for (const video of doneVideos) {
      const title = (video.video_title as string | null) ?? (video.video_id as string);

      // rewritten_storage_path = "transcripts/{job_id}/{video_id}/rewritten.txt"
      // storage.from('transcripts').download() needs path WITHOUT bucket prefix
      const rewrittenPath = (video.rewritten_storage_path as string)
        .replace(/^transcripts\//, '');

      const { data: fileData } = await admin
        .storage
        .from('transcripts')
        .download(rewrittenPath);

      const content = fileData ? await fileData.text() : '*(rewritten content unavailable)*';

      lines.push(
        `## ${title}`,
        '',
        `**URL:** https://www.youtube.com/watch?v=${video.video_id as string}`,
        '',
        content.trim(),
        '',
        '---',
        ''
      );
    }

    // Failed section at end
    if (failedVideos.length > 0) {
      lines.push('## ⚠️ Failed Videos', '');
      for (const video of failedVideos) {
        const title = (video.video_title as string | null) ?? (video.video_id as string);
        lines.push(
          `### ${title}`,
          `**URL:** https://www.youtube.com/watch?v=${video.video_id as string}`,
          `**Error:** ${(video.rewrite_error as string | null) ?? 'Unknown error'}`,
          ''
        );
      }
    }

    const markdownBundle = lines.join('\n');
    const storagePath    = `${id}/export.md`;

    const { error: uploadError } = await admin
      .storage
      .from('exports')
      .upload(storagePath, markdownBundle, {
        contentType: 'text/markdown',
        upsert: true,
      });

    if (uploadError) throw new Error(`Export upload failed: ${uploadError.message}`);

    // Record in exports table
    await admin.from('exports').upsert({
      job_id:          id,
      storage_path:    `exports/${storagePath}`,
      file_size_bytes: Buffer.byteLength(markdownBundle, 'utf8'),
      video_count:     (allVideos ?? []).length,
      success_count:   doneVideos.length,
      failed_count:    failedVideos.length,
      bundle_format:   'markdown',
    }, { onConflict: 'job_id' });

    const finalStatus = failedVideos.length > 0 ? 'completed_with_errors' : 'completed';

    await admin.from('jobs').update({
      status:             finalStatus,
      export_storage_path: `exports/${storagePath}`,
      export_ready:       true,
      completed_at:       new Date().toISOString(),
      rewrite_success_count: doneVideos.length,
      rewrite_failed_count:  failedVideos.length,
    }).eq('id', id);

    return NextResponse.json<ApiResponse>({
      success: true,
      data: {
        storage_path:  `exports/${storagePath}`,
        video_count:   doneVideos.length,
        failed_count:  failedVideos.length,
        final_status:  finalStatus,
      },
    });

  } catch (err) {
    const message = err instanceof Error ? err.message : 'Export failed';
    console.error('[export] fatal:', message);
    await admin.from('jobs').update({
      status: 'failed',
      error_message: message,
    }).eq('id', id).catch(() => {});
    return NextResponse.json<ApiResponse>({ success: false, error: message }, { status: 500 });
  }
}
