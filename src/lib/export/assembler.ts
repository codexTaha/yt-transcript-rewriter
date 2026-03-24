/**
 * src/lib/export/assembler.ts
 * Bundle assembler utility — Phase 5.1
 * Builds the final Markdown export from job + video data.
 */

export interface AssemblerJob {
  source_name?:   string | null;
  source_url:     string;
  master_prompt?: string | null;
  ai_model?:      string | null;
  created_at?:    string | null;
  completed_at?:  string | null;
  transcript_success_count?: number;
  transcript_failed_count?:  number;
  rewrite_success_count?:    number;
  rewrite_failed_count?:     number;
}

export interface AssemblerVideo {
  video_id:                string;
  video_title?:            string | null;
  discovery_position?:     number;
  transcript_status:       string;
  rewrite_status:          string;
  transcript_word_count?:  number | null;
  rewrite_chunk_count?:    number | null;
  rewrite_model_used?:     string | null;
  rewritten_content?:      string | null; // already loaded by caller
  transcript_error?:       string | null;
  rewrite_error?:          string | null;
}

/**
 * Assemble the complete Markdown bundle string.
 * The caller is responsible for loading rewritten_content from storage.
 */
export function assembleBundleMd(
  job:    AssemblerJob,
  videos: AssemblerVideo[]
): string {
  const done    = videos.filter(v => v.rewrite_status === 'done');
  const failed  = videos.filter(v => v.rewrite_status === 'failed');
  const skipped = videos.filter(v => v.transcript_status === 'skipped' || v.transcript_status === 'failed');

  const lines: string[] = [];

  // ── Title block ────────────────────────────────────────────────────────────
  lines.push(
    `# ${job.source_name ?? 'YouTube Transcript Bundle'}`,
    '',
    `| Field | Value |`,
    `|---|---|`,
    `| **Source** | ${job.source_url} |`,
    `| **Prompt** | ${job.master_prompt ?? '—'} |`,
    `| **Model** | ${job.ai_model ?? '—'} |`,
    `| **Generated** | ${new Date().toUTCString()} |`,
    `| **Rewritten** | ${done.length} / ${videos.length} videos |`,
    `| **Failed rewrites** | ${failed.length} |`,
    `| **No transcript** | ${skipped.length} |`,
    '',
    '---',
    ''
  );

  // ── Table of Contents ──────────────────────────────────────────────────────
  if (done.length > 0) {
    lines.push('## Table of Contents', '');
    done.forEach((v, i) => {
      const title  = v.video_title ?? v.video_id;
      const anchor = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      lines.push(`${i + 1}. [${title}](#${anchor})`);
    });
    lines.push('', '---', '');
  }

  // ── Rewritten sections ─────────────────────────────────────────────────────
  for (const video of done) {
    const title = video.video_title ?? video.video_id;
    lines.push(
      `## ${title}`,
      '',
      `**URL:** https://www.youtube.com/watch?v=${video.video_id}`,
    );
    if (video.transcript_word_count) {
      lines.push(`**Original word count:** ${video.transcript_word_count.toLocaleString()}`);
    }
    if (video.rewrite_chunk_count && video.rewrite_chunk_count > 1) {
      lines.push(`**Chunks:** ${video.rewrite_chunk_count}`);
    }
    lines.push(
      '',
      (video.rewritten_content ?? '*(rewritten content unavailable)*').trim(),
      '',
      '---',
      ''
    );
  }

  // ── Failed rewrites ────────────────────────────────────────────────────────
  if (failed.length > 0) {
    lines.push('## ⚠️ Rewrite Failed', '');
    for (const video of failed) {
      lines.push(
        `### ${video.video_title ?? video.video_id}`,
        `**URL:** https://www.youtube.com/watch?v=${video.video_id}`,
        `**Error:** ${video.rewrite_error ?? 'Unknown error'}`,
        ''
      );
    }
    lines.push('---', '');
  }

  // ── No-transcript videos ───────────────────────────────────────────────────
  if (skipped.length > 0) {
    lines.push('## ❌ Transcript Unavailable', '');
    for (const video of skipped) {
      lines.push(
        `### ${video.video_title ?? video.video_id}`,
        `**URL:** https://www.youtube.com/watch?v=${video.video_id}`,
        video.transcript_error ? `**Reason:** ${video.transcript_error}` : '**Reason:** No captions available',
        ''
      );
    }
  }

  return lines.join('\n');
}
