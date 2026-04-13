import type { ValidatedYouTubeUrl } from '@/types';

// Regex patterns for each YouTube URL shape.
// ORDER MATTERS: playlist must be checked before video because a URL like
// youtube.com/watch?v=xxx&list=PLxxx matches both — we want playlist in that case.
const PATTERNS = {
  // Playlist: /playlist?list=xxx  OR  watch?...list=xxx (with or without v=)
  playlist: [
    // Clean playlist URL — most reliable
    /youtube\.com\/playlist\?.*list=([\w-]+)/,
    // Watch URL that has a list= param (shared playlist link from YouTube sidebar)
    // Captures list even when v= is also present — this was the original bug:
    // the old negative lookahead `(?!.*[&?]v=)` caused this pattern to fail
    // for the most common case (youtube.com/watch?v=xxx&list=PLxxx).
    /youtube\.com\/watch\?[^#]*[?&]list=([\w-]+)/,
  ],
  // Channel: /@handle, /channel/UCxxx, /c/name, /user/name
  channel: [
    /youtube\.com\/@([\w-]+)/,
    /youtube\.com\/channel\/(UC[\w-]+)/,
    /youtube\.com\/c\/([\w-]+)/,
    /youtube\.com\/user\/([\w-]+)/,
  ],
  // Single video: /watch?v=xxx or youtu.be/xxx
  // Checked AFTER playlist so watch+list URLs go to playlist, not video.
  video: [
    /youtube\.com\/watch\?.*v=([\w-]{11})/,
    /youtu\.be\/([\w-]{11})/,
    /youtube\.com\/shorts\/([\w-]{11})/,
    /youtube\.com\/embed\/([\w-]{11})/,
  ],
};

/**
 * Strips trailing /videos, /shorts, /streams, /about, etc. from channel URLs
 */
function normalizeChannelUrl(url: string): string {
  return url
    .replace(/\/(videos|shorts|streams|playlists|community|about|featured)(\?.*)?$/, '')
    .replace(/\/$/, '');
}

/**
 * Validates and classifies a YouTube URL.
 * Returns a structured result or null if invalid.
 *
 * Priority: playlist > channel > video
 * Rationale: a watch?v=xxx&list=PLxxx URL should be treated as a playlist job,
 * not a single-video job. The user pasted a playlist link.
 */
export function validateYouTubeUrl(rawUrl: string): ValidatedYouTubeUrl | null {
  const url = rawUrl.trim();

  // Must contain youtube.com or youtu.be
  if (!/youtube\.com|youtu\.be/.test(url)) return null;

  // 1. Check playlist first
  for (const pattern of PATTERNS.playlist) {
    const match = url.match(pattern);
    if (match) {
      return {
        type: 'playlist',
        normalizedUrl: `https://www.youtube.com/playlist?list=${match[1]}`,
        rawId: match[1],
      };
    }
  }

  // 2. Check channel
  for (const pattern of PATTERNS.channel) {
    const match = url.match(pattern);
    if (match) {
      const normalized = normalizeChannelUrl(url);
      return {
        type: 'channel',
        normalizedUrl: normalized,
        rawId: match[1],
      };
    }
  }

  // 3. Check single video last
  for (const pattern of PATTERNS.video) {
    const match = url.match(pattern);
    if (match) {
      return {
        type: 'video',
        normalizedUrl: `https://www.youtube.com/watch?v=${match[1]}`,
        rawId: match[1],
      };
    }
  }

  return null;
}
