export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

// ─── Job Status ───────────────────────────────────────────────────────────────
export type JobStatus =
  | 'created'
  | 'discovering'
  | 'extracting'
  | 'awaiting_prompt'
  | 'queued_for_rewrite'
  | 'rewriting'
  | 'building_export'
  | 'completed'
  | 'completed_with_errors'
  | 'failed';

// ─── Transcript Status ────────────────────────────────────────────────────────
export type TranscriptStatus = 'pending' | 'processing' | 'done' | 'failed' | 'skipped';

// ─── Rewrite Status ───────────────────────────────────────────────────────────
export type RewriteStatus = 'not_started' | 'queued' | 'processing' | 'done' | 'failed';

// ─── Source Type ──────────────────────────────────────────────────────────────
export type SourceType = 'channel' | 'playlist' | 'video';

// ─── Database Schema ──────────────────────────────────────────────────────────
export interface Database {
  public: {
    Tables: {
      jobs: {
        Row: Job;
        Insert: JobInsert;
        Update: Partial<JobInsert>;
      };
      job_videos: {
        Row: JobVideo;
        Insert: JobVideoInsert;
        Update: Partial<JobVideoInsert>;
      };
      exports: {
        Row: Export;
        Insert: ExportInsert;
        Update: Partial<ExportInsert>;
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
  };
}

// ─── Job ──────────────────────────────────────────────────────────────────────
export interface Job {
  id: string;
  user_id: string;
  source_url: string;
  source_type: SourceType | null;
  source_name: string | null;
  source_channel_id: string | null;
  source_playlist_id: string | null;
  total_video_count: number;
  transcript_success_count: number;
  transcript_failed_count: number;
  rewrite_success_count: number;
  rewrite_failed_count: number;
  master_prompt: string | null;
  prompt_submitted_at: string | null;
  status: JobStatus;
  error_message: string | null;
  ai_provider: string;
  ai_model: string;
  created_at: string;
  discovery_started_at: string | null;
  extraction_started_at: string | null;
  rewrite_started_at: string | null;
  completed_at: string | null;
  export_storage_path: string | null;
  export_ready: boolean;
}

export type JobInsert = Omit<Job, 'id' | 'created_at'>;

// ─── JobVideo ─────────────────────────────────────────────────────────────────
export interface JobVideo {
  id: string;
  job_id: string;
  video_id: string;
  video_title: string | null;
  video_url: string | null;
  channel_name: string | null;
  duration_seconds: number | null;
  discovery_position: number;
  transcript_status: TranscriptStatus;
  transcript_storage_path: string | null;
  transcript_language: string | null;
  transcript_word_count: number | null;
  transcript_char_count: number | null;
  transcript_error: string | null;
  transcript_retry_count: number;
  transcript_attempted_at: string | null;
  transcript_completed_at: string | null;
  rewrite_status: RewriteStatus;
  rewritten_storage_path: string | null;
  rewrite_error: string | null;
  rewrite_retry_count: number;
  rewrite_chunk_count: number | null;
  rewrite_model_used: string | null;
  rewrite_attempted_at: string | null;
  rewrite_completed_at: string | null;
  created_at: string;
}

export type JobVideoInsert = Omit<JobVideo, 'id' | 'created_at'>;

// ─── Export ───────────────────────────────────────────────────────────────────
export interface Export {
  id: string;
  job_id: string;
  storage_path: string;
  file_size_bytes: number | null;
  video_count: number | null;
  success_count: number | null;
  failed_count: number | null;
  bundle_format: string;
  created_at: string;
  expires_at: string | null;
}

export type ExportInsert = Omit<Export, 'id' | 'created_at'>;
