export type * from './database';

// ─── API Response shapes ──────────────────────────────────────────────────────
export interface ApiSuccess<T = unknown> {
  success: true;
  data: T;
}

export interface ApiError {
  success: false;
  error: string;
  code?: string;
}

export type ApiResponse<T = unknown> = ApiSuccess<T> | ApiError;

// ─── YouTube Discovery ────────────────────────────────────────────────────────
export interface DiscoveredVideo {
  video_id: string;
  title: string;
  position: number;
  channel_name?: string;
  duration_seconds?: number;
}

export interface DiscoveryResult {
  videos: DiscoveredVideo[];
  source_name: string;
  source_type: 'channel' | 'playlist' | 'video';
  source_channel_id?: string;
  source_playlist_id?: string;
}

// ─── URL Validation ───────────────────────────────────────────────────────────
export interface ValidatedYouTubeUrl {
  type: 'channel' | 'playlist' | 'video';
  normalizedUrl: string;
  rawId: string;
}
