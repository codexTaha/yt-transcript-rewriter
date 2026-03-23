import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import type { ApiResponse } from '@/types';

// Singleton Innertube client — reused across requests in the same worker process
let _innertubeClient: unknown = null;

async function getInnertube() {
  if (!_innertubeClient) {
    const { Innertube } = await import('youtubei.js');
    _innertubeClient = await Innertube.create({
      retrieve_player: false,
    });
  }
  return _innertubeClient as Awaited<ReturnType<typeof import('youtubei.js').Innertube.create>>;
}

/**
 * Fetch transcript for a video using youtubei.js (Innertube API).
 * Tries English first, then falls back to any available language.
 * Returns plain text string.
 */
async function fetchTranscriptText(videoId: string): Promise<{ text: string; language: string }> {
  const yt = await getInnertube();
  const info = await yt.getInfo(videoId);

  const transcriptData = await info.getTranscript();

  if (!transcriptData?.transcript?.content?.body?.initial_segments) {
    throw new Error('No transcript available for this video');
  }

  const segments = transcriptData.transcript.content.body.initial_segments;

  const text = segments
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((seg: any) => seg?.snippet?.text ?? '')
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (text.length < 50) {
    throw new Error('Transcript too short or empty');
  }

  // Detect language from transcript metadata if available
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lang = (transcriptData.transcript as any)?.content?.footer?.language_menu
    ?.sub_menu_items?.[0]?.title ?? 'en';

  return { text, language: lang };
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
      return NextResponse.json<ApiResponse>({ success: false, error: 'Missing required fields' }, { status: 400 });
    }

    let transcriptText: string;
    let language = 'en';

    try {
      const result = await fetchTranscriptText(video_id);
      transcriptText = result.text;
      language = result.language;
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
        language,
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
