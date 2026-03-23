-- ============================================================
-- Migration 001: Initial schema
-- Run this in Supabase SQL Editor or via Supabase CLI
-- ============================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- JOBS TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS public.jobs (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Source info
  source_url                  TEXT NOT NULL,
  source_type                 TEXT CHECK (source_type IN ('channel', 'playlist', 'video')),
  source_name                 TEXT,
  source_channel_id           TEXT,
  source_playlist_id          TEXT,

  -- Progress counters
  total_video_count           INTEGER NOT NULL DEFAULT 0,
  transcript_success_count    INTEGER NOT NULL DEFAULT 0,
  transcript_failed_count     INTEGER NOT NULL DEFAULT 0,
  rewrite_success_count       INTEGER NOT NULL DEFAULT 0,
  rewrite_failed_count        INTEGER NOT NULL DEFAULT 0,

  -- Prompt
  master_prompt               TEXT,
  prompt_submitted_at         TIMESTAMPTZ,

  -- State
  status                      TEXT NOT NULL DEFAULT 'created'
                              CHECK (status IN (
                                'created', 'discovering', 'extracting',
                                'awaiting_prompt', 'queued_for_rewrite', 'rewriting',
                                'building_export', 'completed', 'completed_with_errors', 'failed'
                              )),
  error_message               TEXT,

  -- AI provider metadata (never hardcode in app logic)
  ai_provider                 TEXT NOT NULL DEFAULT 'anthropic',
  ai_model                    TEXT NOT NULL DEFAULT 'claude-3-5-sonnet-20241022',

  -- Timestamps
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  discovery_started_at        TIMESTAMPTZ,
  extraction_started_at       TIMESTAMPTZ,
  rewrite_started_at          TIMESTAMPTZ,
  completed_at                TIMESTAMPTZ,

  -- Export
  export_storage_path         TEXT,
  export_ready                BOOLEAN NOT NULL DEFAULT FALSE
);

-- ============================================================
-- JOB_VIDEOS TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS public.job_videos (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id                      UUID NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,

  -- YouTube metadata
  video_id                    TEXT NOT NULL,
  video_title                 TEXT,
  video_url                   TEXT,
  channel_name                TEXT,
  duration_seconds            INTEGER,
  discovery_position          INTEGER NOT NULL DEFAULT 0,

  -- Transcript extraction
  transcript_status           TEXT NOT NULL DEFAULT 'pending'
                              CHECK (transcript_status IN (
                                'pending', 'processing', 'done', 'failed', 'skipped'
                              )),
  transcript_storage_path     TEXT,
  transcript_language         TEXT,
  transcript_word_count       INTEGER,
  transcript_char_count       INTEGER,
  transcript_error            TEXT,
  transcript_retry_count      INTEGER NOT NULL DEFAULT 0,
  transcript_attempted_at     TIMESTAMPTZ,
  transcript_completed_at     TIMESTAMPTZ,

  -- AI rewrite
  rewrite_status              TEXT NOT NULL DEFAULT 'not_started'
                              CHECK (rewrite_status IN (
                                'not_started', 'queued', 'processing', 'done', 'failed'
                              )),
  rewritten_storage_path      TEXT,
  rewrite_error               TEXT,
  rewrite_retry_count         INTEGER NOT NULL DEFAULT 0,
  rewrite_chunk_count         INTEGER,
  rewrite_model_used          TEXT,
  rewrite_attempted_at        TIMESTAMPTZ,
  rewrite_completed_at        TIMESTAMPTZ,

  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- EXPORTS TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS public.exports (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id            UUID NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  storage_path      TEXT NOT NULL,
  file_size_bytes   INTEGER,
  video_count       INTEGER,
  success_count     INTEGER,
  failed_count      INTEGER,
  bundle_format     TEXT NOT NULL DEFAULT 'markdown',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at        TIMESTAMPTZ
);

-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_jobs_user_id           ON public.jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status            ON public.jobs(status);
CREATE INDEX IF NOT EXISTS idx_job_videos_job_id      ON public.job_videos(job_id);
CREATE INDEX IF NOT EXISTS idx_job_videos_ts_status   ON public.job_videos(job_id, transcript_status);
CREATE INDEX IF NOT EXISTS idx_job_videos_rw_status   ON public.job_videos(job_id, rewrite_status);
CREATE INDEX IF NOT EXISTS idx_exports_job_id         ON public.exports(job_id);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
ALTER TABLE public.jobs       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_videos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exports    ENABLE ROW LEVEL SECURITY;

-- jobs: users own their own jobs
CREATE POLICY "Users can manage their own jobs"
  ON public.jobs FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- job_videos: access via job ownership
CREATE POLICY "Users can view their job videos"
  ON public.job_videos FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.jobs
      WHERE jobs.id = job_videos.job_id
        AND jobs.user_id = auth.uid()
    )
  );

CREATE POLICY "Service role manages job_videos"
  ON public.job_videos FOR ALL
  USING (true)
  WITH CHECK (true);

-- exports: access via job ownership
CREATE POLICY "Users can view their exports"
  ON public.exports FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.jobs
      WHERE jobs.id = exports.job_id
        AND jobs.user_id = auth.uid()
    )
  );

CREATE POLICY "Service role manages exports"
  ON public.exports FOR ALL
  USING (true)
  WITH CHECK (true);

-- ============================================================
-- REALTIME
-- Enable realtime on these tables so the frontend can subscribe
-- ============================================================
ALTER PUBLICATION supabase_realtime ADD TABLE public.jobs;
ALTER PUBLICATION supabase_realtime ADD TABLE public.job_videos;
