/**
 * src/lib/export/assembler.ts
 * Builds two plain-text export bundles:
 *   - raw_transcripts.txt    (original transcripts)
 *   - rewritten_transcripts.txt  (AI-rewritten transcripts)
 *
 * Format per video:
 *   Video N — Title
 *   URL: https://...
 *   Duration: Xh Ym
 *   ──────────────────────────────────────────────────────────────────────
 *   <transcript text>
 *   ──────────────────────────────────────────────────────────────────────
 *   (blank line between videos)
 */

export interface AssemblerJob {
  source_name?:              string | null;
  source_url:                string;
  master_prompt?:            string | null;
  ai_model?:                 string | null;
  created_at?:               string | null;
  completed_at?:             string | null;
  transcript_success_count?: number;
  transcript_failed_count?:  number;
  rewrite_success_count?:    number;
  rewrite_failed_count?:     number;
}

export interface AssemblerVideo {
  video_id:               string;
  video_title?:           string | null;
  discovery_position?:    number;
  duration_seconds?:      number | null;
  transcript_status:      string;
  rewrite_status:         string;
  transcript_word_count?: number | null;
  rewrite_chunk_count?:   number | null;
  rewrite_model_used?:    string | null;
  raw_content?:           string | null;  // original transcript
  rewritten_content?:     string | null;  // AI rewrite
  transcript_error?:      string | null;
  rewrite_error?:         string | null;
}

const DIVIDER = '─'.repeat(70);

function formatDuration(sec: number | null | undefined): string {
  if (!sec) return 'unknown';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function buildHeader(job: AssemblerJob, label: string): string[] {
  const lines: string[] = [];
  lines.push(`${label}`);
  lines.push(`Source : ${job.source_name ?? 'YouTube'} — ${job.source_url}`);
  lines.push(`Model  : ${job.ai_model ?? '—'}`);
  lines.push(`Date   : ${new Date().toUTCString()}`);
  lines.push(DIVIDER);
  lines.push('');
  return lines;
}

function videoBlock(
  video:   AssemblerVideo,
  index:   number,
  content: string | null | undefined,
  label:   string
): string[] {
  const title    = video.video_title ?? video.video_id;
  const url      = `https://www.youtube.com/watch?v=${video.video_id}`;
  const duration = formatDuration(video.duration_seconds);

  const lines: string[] = [];
  lines.push(`Video ${index} — ${title}`);
  lines.push(`URL      : ${url}`);
  lines.push(`Duration : ${duration}`);
  if (video.transcript_word_count) {
    lines.push(`Words    : ${video.transcript_word_count.toLocaleString()}`);
  }
  lines.push(DIVIDER);
  lines.push('');
  if (content?.trim()) {
    lines.push(content.trim());
  } else {
    lines.push(`[${label} unavailable — ${video.transcript_error ?? video.rewrite_error ?? 'no content'}]`);
  }
  lines.push('');
  lines.push(DIVIDER);
  lines.push('');
  lines.push('');
  return lines;
}

/** Build raw_transcripts.txt */
export function assembleRawTxt(job: AssemblerJob, videos: AssemblerVideo[]): string {
  const lines = buildHeader(job, 'RAW TRANSCRIPTS');
  const withTranscript = videos.filter(v => v.transcript_status === 'done' || v.raw_content);
  if (withTranscript.length === 0) {
    lines.push('[No transcripts available]');
    return lines.join('\n');
  }
  withTranscript.forEach((v, i) => {
    lines.push(...videoBlock(v, i + 1, v.raw_content, 'transcript'));
  });
  return lines.join('\n');
}

/** Build rewritten_transcripts.txt */
export function assembleRewrittenTxt(job: AssemblerJob, videos: AssemblerVideo[]): string {
  const lines = buildHeader(job, 'REWRITTEN TRANSCRIPTS');
  const done    = videos.filter(v => v.rewrite_status === 'done');
  const failed  = videos.filter(v => v.rewrite_status === 'failed');
  const skipped = videos.filter(v => !['done', 'failed'].includes(v.rewrite_status));

  if (done.length === 0) {
    lines.push('[No rewritten transcripts available]');
    return lines.join('\n');
  }

  done.forEach((v, i) => {
    lines.push(...videoBlock(v, i + 1, v.rewritten_content, 'rewrite'));
  });

  if (failed.length > 0) {
    lines.push('FAILED REWRITES');
    lines.push(DIVIDER);
    failed.forEach(v => {
      lines.push(`• Video ${v.discovery_position ?? '?'} — ${v.video_title ?? v.video_id}`);
      lines.push(`  Error: ${v.rewrite_error ?? 'unknown'}`);
    });
    lines.push('');
  }

  if (skipped.length > 0) {
    lines.push('NO TRANSCRIPT AVAILABLE');
    lines.push(DIVIDER);
    skipped.forEach(v => {
      lines.push(`• ${v.video_title ?? v.video_id} — ${v.transcript_error ?? 'no captions'}`);
    });
  }

  return lines.join('\n');
}

// Keep old function for backward compatibility during transition
export function assembleBundleMd(job: AssemblerJob, videos: AssemblerVideo[]): string {
  return assembleRewrittenTxt(job, videos);
}
