import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { fetchTranscript } from '@/lib/transcript/fetchTranscript';
import type { ApiResponse } from '@/types';

// Error messages that mean the video is permanently gone — no point retrying
const PERMANENT_ERROR_PATTERNS = [
  'account associated with this video has been terminated',
  'video has been removed',
  'This video is unavailable',
  'Transcripts are disabled',
  'TranscriptsDisabled',
  'This video is private',
];

function isPermanentError(msg: string): boolean {
  return PERMANENT_ERROR_PATTERNS.some(p => msg.toLowerCase().includes(p.toLowerCase()));
}

export async function POST(req: NextRequest) {
  const admin = createAdminClient();

  let job_video_id: string | undefined;
  let job_id: string | undefined;

  try {
    const body = await req.json();
    job_video_id = body.job_video_id;
    job_id = body.job_id;
    const video_id: string = body.video_id;

    if (!job_video_id || !job_id || !video_id) {
      return NextResponse.json<ApiResponse>(
        { success: false, error: 'Missing required fields' },
        { status: 400 }
      );
    }

    // Bail immediately if the job was cancelled
    const { data: job } = await admin
      .from('jobs')
      .select('status')
      .eq('id', job_id)
      .single();

    if (!job || job.status === 'cancelled') {
      await admin.from('job_videos').update({ transcript_status: 'skipped' }).eq('id', job_video_id);
      return NextResponse.json<ApiResponse>({ success: false, error: 'Job cancelled' }, { status: 409 });
    }

    let transcriptText: string;
    let language = 'en';

    try {
      const result = await fetchTranscript(video_id);
      transcriptText = result.text;
      language = result.language;
    } catch (transcriptErr) {
      const errMsg =
        transcriptErr instanceof Error ? transcriptErr.message : 'Transcript fetch failed';
      console.error(`[extract] video ${video_id}:`, errMsg);

      const { data: current } = await admin
        .from('job_videos')
        .select('transcript_retry_count')
        .eq('id', job_video_id)
        .single();

      const retryCount = (current?.transcript_retry_count ?? 0) + 1;
      // Permanently failed errors or exceeded retry limit → mark as failed immediately
      const newStatus = isPermanentError(errMsg) || retryCount >= 3 ? 'failed' : 'pending';

      await admin
        .from('job_videos')
        .update({
          transcript_status: newStatus,
          transcript_error: errMsg,
          transcript_retry_count: retryCount,
        })
        .eq('id', job_video_id);

      return NextResponse.json<ApiResponse>(
        { success: false, error: errMsg },
        { status: 422 }
      );
    }

    // Upload to Supabase Storage
    const storagePath = `${job_id}/${video_id}/transcript.txt`;
    const { error: uploadError } = await admin
      .storage
      .from('transcripts')
      .upload(storagePath, transcriptText, { contentType: 'text/plain', upsert: true });

    if (uploadError) throw new Error(`Storage upload failed: ${uploadError.message}`);

    await admin
      .from('job_videos')
      .update({
        transcript_status: 'done',
        transcript_storage_path: `transcripts/${storagePath}`,
        transcript_language: language,
        transcript_word_count: transcriptText.split(/\s+/).length,
        transcript_char_count: transcriptText.length,
        transcript_error: null,
        transcript_completed_at: new Date().toISOString(),
      })
      .eq('id', job_video_id);

    return NextResponse.json<ApiResponse>({
      success: true,
      data: {
        video_id,
        word_count: transcriptText.split(/\s+/).length,
        char_count: transcriptText.length,
        language,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Extraction failed';
    console.error('[extract worker] fatal:', message);
    if (job_video_id) {
      await admin
        .from('job_videos')
        .update({
          transcript_status: 'failed',
          transcript_error: message,
        })
        .eq('id', job_video_id)
        .catch(() => {});
    }
    return NextResponse.json<ApiResponse>(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
