/**
 * POST /api/jobs/[id]/export
 * Assembles the final Markdown bundle from all rewritten transcripts.
 * Called automatically by the rewrite pump when all videos complete.
 * Phase 5.2
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { assembleBundleMd } from '@/lib/export/assembler';
import type { ApiResponse } from '@/types';

export const maxDuration = 60;

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const admin  = createAdminClient();

  try {
    // ── Load job ────────────────────────────────────────────────────────────
    const { data: job } = await admin
      .from('jobs')
      .select('*')
      .eq('id', id)
      .single();

    if (!job) {
      return NextResponse.json<ApiResponse>(
        { success: false, error: 'Job not found' },
        { status: 404 }
      );
    }

    // ── Load all videos ────────────────────────────────────────────────────
    const { data: allVideos } = await admin
      .from('job_videos')
      .select('*')
      .eq('job_id', id)
      .order('discovery_position', { ascending: true });

    const videos = allVideos ?? [];
    const doneVideos = videos.filter(v => v.rewrite_status === 'done');

    if (doneVideos.length === 0) {
      await admin
        .from('jobs')
        .update({ status: 'failed', error_message: 'No successfully rewritten videos to export' })
        .eq('id', id);
      return NextResponse.json<ApiResponse>(
        { success: false, error: 'Nothing to export' },
        { status: 422 }
      );
    }

    // ── Load rewritten content for each done video ─────────────────────────
    const videosWithContent = await Promise.all(
      videos.map(async (v) => {
        if (v.rewrite_status !== 'done' || !v.rewritten_storage_path) {
          return { ...v, rewritten_content: null };
        }
        // rewritten_storage_path = "transcripts/{job_id}/{video_id}/rewritten.txt"
        const path = (v.rewritten_storage_path as string).replace(/^transcripts\//, '');
        const { data: fileData } = await admin.storage.from('transcripts').download(path);
        const content = fileData ? await fileData.text() : null;
        return { ...v, rewritten_content: content };
      })
    );

    // ── Assemble Markdown bundle ───────────────────────────────────────────
    const markdownBundle = assembleBundleMd(
      {
        source_name:              job.source_name   as string | null,
        source_url:               job.source_url    as string,
        master_prompt:            job.master_prompt as string | null,
        ai_model:                 job.ai_model      as string | null,
        created_at:               job.created_at    as string | null,
        completed_at:             null,
        transcript_success_count: job.transcript_success_count as number,
        transcript_failed_count:  job.transcript_failed_count  as number,
        rewrite_success_count:    doneVideos.length,
        rewrite_failed_count:     videos.filter(v => v.rewrite_status === 'failed').length,
      },
      videosWithContent.map(v => ({
        video_id:               v.video_id               as string,
        video_title:            v.video_title             as string | null,
        discovery_position:     v.discovery_position      as number,
        transcript_status:      v.transcript_status       as string,
        rewrite_status:         v.rewrite_status          as string,
        transcript_word_count:  v.transcript_word_count   as number | null,
        rewrite_chunk_count:    v.rewrite_chunk_count     as number | null,
        rewrite_model_used:     v.rewrite_model_used      as string | null,
        rewritten_content:      (v as { rewritten_content?: string | null }).rewritten_content ?? null,
        transcript_error:       v.transcript_error        as string | null,
        rewrite_error:          v.rewrite_error           as string | null,
      }))
    );

    // ── Upload to exports bucket ───────────────────────────────────────────
    const storagePath = `${id}/export.md`;
    const { error: uploadError } = await admin
      .storage
      .from('exports')
      .upload(storagePath, markdownBundle, { contentType: 'text/markdown', upsert: true });

    if (uploadError) throw new Error(`Export upload failed: ${uploadError.message}`);

    // ── Record in exports table ────────────────────────────────────────────
    await admin
      .from('exports')
      .upsert(
        {
          job_id:          id,
          storage_path:    `exports/${storagePath}`,
          file_size_bytes: Buffer.byteLength(markdownBundle, 'utf8'),
          video_count:     videos.length,
          success_count:   doneVideos.length,
          failed_count:    videos.filter(v => v.rewrite_status === 'failed').length,
          bundle_format:   'markdown',
        },
        { onConflict: 'job_id' }
      );

    const failedCount  = videos.filter(v => v.rewrite_status === 'failed').length;
    const finalStatus  = failedCount > 0 ? 'completed_with_errors' : 'completed';

    await admin
      .from('jobs')
      .update({
        status:               finalStatus,
        export_storage_path:  `exports/${storagePath}`,
        export_ready:         true,
        completed_at:         new Date().toISOString(),
        rewrite_success_count: doneVideos.length,
        rewrite_failed_count:  failedCount,
      })
      .eq('id', id);

    return NextResponse.json<ApiResponse>({
      success: true,
      data:    { storage_path: `exports/${storagePath}`, video_count: doneVideos.length, final_status: finalStatus },
    });

  } catch (err) {
    const message = err instanceof Error ? err.message : 'Export failed';
    console.error('[export] fatal:', message);
    await admin
      .from('jobs')
      .update({ status: 'failed', error_message: message })
      .eq('id', id)
      .then();
    return NextResponse.json<ApiResponse>({ success: false, error: message }, { status: 500 });
  }
}
