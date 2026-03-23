import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import type { ApiResponse } from '@/types';

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
      return NextResponse.json<ApiResponse>({ success: false, error: 'Missing required fields' }, { status: 400 });
    }

    let transcriptText: string;
    const language = 'en';

    try {
      const { YoutubeTranscript } = await import('youtube-transcript');
      const entries = await YoutubeTranscript.fetchTranscript(video_id, { lang: 'en' })
        .catch(() => YoutubeTranscript.fetchTranscript(video_id)); // fallback: any language

      if (!entries || entries.length === 0) {
        throw new Error('No transcript available for this video');
      }

      transcriptText = entries
        .map((e: { text: string }) => e.text.trim())
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();

      if (transcriptText.length < 50) {
        throw new Error('Transcript too short or empty');
      }

    } catch (transcriptErr) {
      const errMsg = transcriptErr instanceof Error ? transcriptErr.message : 'Transcript fetch failed';
      console.error(`[extract] video ${video_id}:`, errMsg);

      const { data: current } = await admin
        .from('job_videos')
        .select('transcript_retry_count')
        .eq('id', job_video_id)
        .single();

      const retryCount = (current?.transcript_retry_count ?? 0) + 1;
      const newStatus = retryCount >= 3 ? 'failed' : 'pending';

      await admin.from('job_videos').update({
        transcript_status: newStatus,
        transcript_error: errMsg,
        transcript_retry_count: retryCount,
      }).eq('id', job_video_id);

      return NextResponse.json<ApiResponse>({ success: false, error: errMsg }, { status: 422 });
    }

    // Upload to Supabase Storage
    const storagePath = `${job_id}/${video_id}/transcript.txt`;
    const { error: uploadError } = await admin
      .storage
      .from('transcripts')
      .upload(storagePath, transcriptText, { contentType: 'text/plain', upsert: true });

    if (uploadError) throw new Error(`Storage upload failed: ${uploadError.message}`);

    await admin.from('job_videos').update({
      transcript_status: 'done',
      transcript_storage_path: `transcripts/${storagePath}`,
      transcript_language: language,
      transcript_word_count: transcriptText.split(/\s+/).length,
      transcript_char_count: transcriptText.length,
      transcript_error: null,
      transcript_completed_at: new Date().toISOString(),
    }).eq('id', job_video_id);

    return NextResponse.json<ApiResponse>({
      success: true,
      data: {
        video_id,
        word_count: transcriptText.split(/\s+/).length,
        char_count: transcriptText.length,
      }
    });

  } catch (err) {
    const message = err instanceof Error ? err.message : 'Extraction failed';
    console.error('[extract worker] fatal:', message);
    if (job_video_id) {
      await admin.from('job_videos').update({
        transcript_status: 'failed',
        transcript_error: message,
      }).eq('id', job_video_id).catch(() => {});
    }
    return NextResponse.json<ApiResponse>({ success: false, error: message }, { status: 500 });
  }
}
