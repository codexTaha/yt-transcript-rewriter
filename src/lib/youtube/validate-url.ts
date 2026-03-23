import type { ValidatedYouTubeUrl } from '@/types';

// Regex patterns for each YouTube URL shape
const PATTERNS = {
  // Channel: /@handle, /channel/UCxxx, /c/name, /user/name
  channel: [
    /youtube\.com\/@([\w-]+)/,
    /youtube\.com\/channel\/(UC[\w-]+)/,
    /youtube\.com\/c\/([\w-]+)/,
    /youtube\.com\/user\/([\w-]+)/,
  ],
  // Playlist: /playlist?list=xxx or any URL with list= but no v=
  playlist: [
    /youtube\.com\/playlist\?.*list=([\w-]+)/,
    /youtube\.com\/watch\?.*list=([\w-]+)(?!.*[&?]v=)/,
  ],
  // Single video: /watch?v=xxx or youtu.be/xxx
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
 */
export function validateYouTubeUrl(rawUrl: string): ValidatedYouTubeUrl | null {
  const url = rawUrl.trim();

  // Must contain youtube.com or youtu.be
  if (!/youtube\.com|youtu\.be/.test(url)) return null;

  // Check video first (most specific)
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

  // Check playlist
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

  // Check channel
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

  return null;
}
