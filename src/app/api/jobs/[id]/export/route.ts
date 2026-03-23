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
    const { data: job } = await admin
      .from('jobs')
      .select('*')
      .eq('id', id)
      .single();

    if (!job) {
      return NextResponse.json<ApiResponse>({ success: false, error: 'Job not found' }, { status: 404 });
    }

    // Get all successfully rewritten videos
    const { data: videos } = await admin
      .from('job_videos')
      .select('*')
      .eq('job_id', id)
      .eq('rewrite_status', 'done')
      .order('discovery_position', { ascending: true });

    if (!videos || videos.length === 0) {
      await admin.from('jobs').update({
        status: 'failed',
        error_message: 'No successfully rewritten videos to export'
      }).eq('id', id);
      return NextResponse.json<ApiResponse>({ success: false, error: 'Nothing to export' }, { status: 422 });
    }

    // Build markdown bundle
    const sections: string[] = [
      `# Export: ${job.source_name ?? 'YouTube Job'}`,
      `**Source:** ${job.source_url}`,
      `**Prompt:** ${job.master_prompt}`,
      `**Generated:** ${new Date().toISOString()}`,
      `**Videos:** ${videos.length}`,
      '',
      '---',
      '',
    ];

    for (const video of videos) {
      // Download rewritten content from storage
      const path = video.rewritten_storage_path?.replace('rewrites/', '') ?? '';
      const { data: fileData } = await admin
        .storage
        .from('rewrites')
        .download(path);

      const content = fileData ? await fileData.text() : '*(content unavailable)*';

      sections.push(
        `## ${video.video_title ?? video.video_id}`,
        `**URL:** https://www.youtube.com/watch?v=${video.video_id}`,
        '',
        content,
        '',
        '---',
        ''
      );
    }

    const markdownBundle = sections.join('\n');
    const storagePath = `${id}/export.md`;

    // Upload to exports bucket
    const { error: uploadError } = await admin
      .storage
      .from('exports')
      .upload(storagePath, markdownBundle, {
        contentType: 'text/markdown',
        upsert: true,
      });

    if (uploadError) throw new Error(`Export upload failed: ${uploadError.message}`);

    // Record export + mark job complete
    await admin.from('exports').insert({
      job_id: id,
      storage_path: `exports/${storagePath}`,
      file_size_bytes: markdownBundle.length,
      video_count: videos.length,
      success_count: videos.length,
      failed_count: 0,
      bundle_format: 'markdown',
    });

    const finalStatus = (job.rewrite_failed_count ?? 0) > 0 ? 'completed_with_errors' : 'completed';

    await admin.from('jobs').update({
      status: finalStatus,
      export_storage_path: `exports/${storagePath}`,
      export_ready: true,
      completed_at: new Date().toISOString(),
    }).eq('id', id);

    return NextResponse.json<ApiResponse>({
      success: true,
      data: { storage_path: `exports/${storagePath}`, video_count: videos.length }
    });

  } catch (err) {
    const message = err instanceof Error ? err.message : 'Export failed';
    await admin.from('jobs').update({ status: 'failed', error_message: message }).eq('id', id).catch(() => {});
    return NextResponse.json<ApiResponse>({ success: false, error: message }, { status: 500 });
  }
}
