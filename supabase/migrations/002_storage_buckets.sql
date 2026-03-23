-- ============================================================
-- Migration 002: Storage buckets
-- Run AFTER 001_initial_schema.sql
-- ============================================================

-- Create buckets (idempotent)
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES
  ('transcripts', 'transcripts', false, 10485760),  -- 10MB per file, private
  ('exports',     'exports',     false, 52428800)    -- 50MB per file, private
ON CONFLICT (id) DO NOTHING;

-- Storage policies for transcripts bucket
-- Users can only read transcripts belonging to their own jobs
CREATE POLICY "Users can read own transcripts"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'transcripts'
    AND (
      -- Path: transcripts/{job_id}/{video_id}/...
      -- Verify the job_id in path belongs to the requesting user
      EXISTS (
        SELECT 1 FROM public.jobs
        WHERE jobs.id::text = (string_to_array(name, '/'))[2]
          AND jobs.user_id = auth.uid()
      )
    )
  );

-- Service role (workers) can write transcripts
CREATE POLICY "Service role manages transcripts"
  ON storage.objects FOR ALL
  USING (bucket_id = 'transcripts')
  WITH CHECK (bucket_id = 'transcripts');

-- Storage policies for exports bucket
CREATE POLICY "Users can read own exports"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'exports'
    AND (
      EXISTS (
        SELECT 1 FROM public.jobs
        WHERE jobs.id::text = (string_to_array(name, '/'))[2]
          AND jobs.user_id = auth.uid()
      )
    )
  );

CREATE POLICY "Service role manages exports"
  ON storage.objects FOR ALL
  USING (bucket_id = 'exports')
  WITH CHECK (bucket_id = 'exports');
