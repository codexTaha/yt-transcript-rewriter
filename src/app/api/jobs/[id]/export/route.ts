/**
 * POST /api/jobs/[id]/export
 * Assembles dual .txt export bundles:
 *   - raw_transcripts.txt      (original transcripts)
 *   - rewritten_transcripts.txt (AI rewrites)
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { assembleRawTxt, assembleRewrittenTxt } from '@/lib/export/assembler';
import type { ApiResponse } from '@/types';

export const maxDuration = 60;

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const admin  = createAdminClient();

  try {
    const { data: job } = await admin.from('jobs').select('*').eq('id', id).single();
    if (!job) return NextResponse.json<ApiResponse>({ success: false, error: 'Job not found' }, { status: 404 });

    const { data: allVideos } = await admin
      .from('job_videos').select('*').eq('job_id', id)
      .order('discovery_position', { ascending: true });

    const videos = allVideos ?? [];
    const doneVideos = videos.filter(v => v.rewrite_status === 'done');

    if (doneVideos.length === 0) {
      await admin.from('jobs').update({ status: 'failed', error_message: 'No successfully rewritten videos to export' }).eq('id', id);
      return NextResponse.json<ApiResponse>({ success: false, error: 'Nothing to export' }, { status: 422 });
    }

    // Load rewritten + raw content for each video
    const videosWithContent = await Promise.all(
      videos.map(async (v) => {
        let raw_content:       string | null = null;
        let rewritten_content: string | null = null;

        // Load raw transcript
        if (v.transcript_storage_path) {
          const rawPath = (v.transcript_storage_path as string).replace(/^transcripts\//, '');
          const { data } = await admin.storage.from('transcripts').download(rawPath);
          if (data) raw_content = await data.text();
        }

        // Load rewritten transcript
        if (v.rewrite_status === 'done' && v.rewritten_storage_path) {
          const rwPath = (v.rewritten_storage_path as string).replace(/^transcripts\//, '');
          const { data } = await admin.storage.from('transcripts').download(rwPath);
          if (data) rewritten_content = await data.text();
        }

        return {
          video_id:              v.video_id               as string,
          video_title:           v.video_title             as string | null,
          discovery_position:    v.discovery_position      as number,
          duration_seconds:      v.duration_seconds        as number | null,
          transcript_status:     v.transcript_status       as string,
          rewrite_status:        v.rewrite_status          as string,
          transcript_word_count: v.transcript_word_count   as number | null,
          rewrite_chunk_count:   v.rewrite_chunk_count     as number | null,
          rewrite_model_used:    v.rewrite_model_used      as string | null,
          raw_content,
          rewritten_content,
          transcript_error:      v.transcript_error        as string | null,
          rewrite_error:         v.rewrite_error           as string | null,
        };
      })
    );

    const jobMeta = {
      source_name:              job.source_name              as string | null,
      source_url:               job.source_url               as string,
      master_prompt:            job.master_prompt            as string | null,
      ai_model:                 job.ai_model                 as string | null,
      created_at:               job.created_at               as string | null,
      completed_at:             null,
      transcript_success_count: job.transcript_success_count as number,
      transcript_failed_count:  job.transcript_failed_count  as number,
      rewrite_success_count:    doneVideos.length,
      rewrite_failed_count:     videos.filter(v => v.rewrite_status === 'failed').length,
    };

    const rawTxt       = assembleRawTxt(jobMeta, videosWithContent);
    const rewrittenTxt = assembleRewrittenTxt(jobMeta, videosWithContent);

    // Upload both files
    const rawPath       = `${id}/raw_transcripts.txt`;
    const rewrittenPath = `${id}/rewritten_transcripts.txt`;

    const [rawUpload, rewrittenUpload] = await Promise.all([
      admin.storage.from('exports').upload(rawPath,       rawTxt,       { contentType: 'text/plain', upsert: true }),
      admin.storage.from('exports').upload(rewrittenPath, rewrittenTxt, { contentType: 'text/plain', upsert: true }),
    ]);

    if (rawUpload.error)       throw new Error(`Raw export upload failed: ${rawUpload.error.message}`);
    if (rewrittenUpload.error) throw new Error(`Rewritten export upload failed: ${rewrittenUpload.error.message}`);

    // Record in exports table (primary = rewritten)
    await admin.from('exports').upsert(
      {
        job_id:          id,
        storage_path:    `exports/${rewrittenPath}`,
        file_size_bytes: Buffer.byteLength(rewrittenTxt, 'utf8'),
        video_count:     videos.length,
        success_count:   doneVideos.length,
        failed_count:    videos.filter(v => v.rewrite_status === 'failed').length,
        bundle_format:   'txt',
      },
      { onConflict: 'job_id' }
    );

    const failedCount = videos.filter(v => v.rewrite_status === 'failed').length;
    const finalStatus = failedCount > 0 ? 'completed_with_errors' : 'completed';

    await admin.from('jobs').update({
      status:               finalStatus,
      export_storage_path:  `exports/${rewrittenPath}`,
      export_ready:         true,
      completed_at:         new Date().toISOString(),
      rewrite_success_count: doneVideos.length,
      rewrite_failed_count:  failedCount,
    }).eq('id', id);

    return NextResponse.json<ApiResponse>({
      success: true,
      data: {
        rewritten_path: `exports/${rewrittenPath}`,
        raw_path:       `exports/${rawPath}`,
        video_count:    doneVideos.length,
        final_status:   finalStatus,
      },
    });

  } catch (err) {
    const message = err instanceof Error ? err.message : 'Export failed';
    console.error('[export] fatal:', message);
    await admin.from('jobs').update({ status: 'failed', error_message: message }).eq('id', id).catch(() => {});
    return NextResponse.json<ApiResponse>({ success: false, error: message }, { status: 500 });
  }
}
