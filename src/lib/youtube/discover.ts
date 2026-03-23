import type { DiscoveryResult, DiscoveredVideo } from '@/types';

const YT_API_BASE = 'https://www.googleapis.com/youtube/v3';
const MAX_RESULTS_PER_PAGE = 50;
const MAX_VIDEOS = 500; // safety cap per job

function apiKey(): string {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) throw new Error('YOUTUBE_API_KEY is not set');
  return key;
}

/** Convert ISO 8601 duration (PT1H2M3S) to total seconds */
function parseDuration(iso: string): number {
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  return (
    (parseInt(match[1] ?? '0') * 3600) +
    (parseInt(match[2] ?? '0') * 60) +
    parseInt(match[3] ?? '0')
  );
}

/** Fetch all video IDs from a playlist, paginating through all pages */
async function fetchPlaylistVideos(
  playlistId: string
): Promise<{ videoIds: string[]; titles: Map<string, string> }> {
  const videoIds: string[] = [];
  const titles = new Map<string, string>();
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({
      part: 'snippet',
      playlistId,
      maxResults: String(MAX_RESULTS_PER_PAGE),
      key: apiKey(),
      ...(pageToken ? { pageToken } : {}),
    });

    const res = await fetch(`${YT_API_BASE}/playlistItems?${params}`);
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err?.error?.message ?? `YouTube API error: ${res.status}`);
    }
    const data = await res.json();

    for (const item of data.items ?? []) {
      const videoId = item.snippet?.resourceId?.videoId;
      const title = item.snippet?.title;
      if (videoId && title !== 'Deleted video' && title !== 'Private video') {
        videoIds.push(videoId);
        titles.set(videoId, title ?? videoId);
      }
    }

    pageToken = data.nextPageToken;
  } while (pageToken && videoIds.length < MAX_VIDEOS);

  return { videoIds, titles };
}

/** Fetch video details (duration, channel) for a batch of video IDs */
async function fetchVideoDetails(
  videoIds: string[]
): Promise<Map<string, { duration: number; channelTitle: string }>> {
  const details = new Map<string, { duration: number; channelTitle: string }>();

  // YouTube API allows max 50 IDs per videos.list call
  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    const params = new URLSearchParams({
      part: 'contentDetails,snippet',
      id: batch.join(','),
      key: apiKey(),
    });

    const res = await fetch(`${YT_API_BASE}/videos?${params}`);
    if (!res.ok) continue;
    const data = await res.json();

    for (const item of data.items ?? []) {
      details.set(item.id, {
        duration: parseDuration(item.contentDetails?.duration ?? ''),
        channelTitle: item.snippet?.channelTitle ?? '',
      });
    }
  }

  return details;
}

/** Resolve a channel handle/URL to its uploads playlist ID */
async function resolveChannelUploadsPlaylist(rawId: string, fullUrl: string): Promise<{
  uploadsPlaylistId: string;
  channelTitle: string;
  channelId: string;
}> {
  // Try by handle first (@channelname)
  const isHandle = rawId.startsWith('@') || fullUrl.includes('/@');
  const handle = rawId.startsWith('@') ? rawId : `@${rawId}`;

  const paramsByHandle = new URLSearchParams({
    part: 'snippet,contentDetails',
    forHandle: handle,
    key: apiKey(),
  });

  const paramsByName = new URLSearchParams({
    part: 'snippet,contentDetails',
    forUsername: rawId,
    key: apiKey(),
  });

  const paramsByChannelId = new URLSearchParams({
    part: 'snippet,contentDetails',
    id: rawId,
    key: apiKey(),
  });

  // Try handle → username → direct channel ID
  const attempts = [
    isHandle ? `${YT_API_BASE}/channels?${paramsByHandle}` : null,
    `${YT_API_BASE}/channels?${paramsByName}`,
    `${YT_API_BASE}/channels?${paramsByChannelId}`,
  ].filter(Boolean) as string[];

  for (const url of attempts) {
    const res = await fetch(url);
    if (!res.ok) continue;
    const data = await res.json();
    const channel = data.items?.[0];
    if (channel) {
      return {
        uploadsPlaylistId: channel.contentDetails.relatedPlaylists.uploads,
        channelTitle: channel.snippet.title,
        channelId: channel.id,
      };
    }
  }

  throw new Error(`Could not resolve channel: ${rawId}. Check the URL is correct and the channel is public.`);
}

/**
 * Main discovery function.
 * Accepts a validated URL object and returns all discovered videos.
 */
export async function discoverVideos(
  type: 'channel' | 'playlist' | 'video',
  rawId: string,
  normalizedUrl: string
): Promise<DiscoveryResult> {

  // ─── Single video ───
  if (type === 'video') {
    const params = new URLSearchParams({
      part: 'snippet,contentDetails',
      id: rawId,
      key: apiKey(),
    });
    const res = await fetch(`${YT_API_BASE}/videos?${params}`);
    if (!res.ok) throw new Error(`YouTube API error: ${res.status}`);
    const data = await res.json();
    const video = data.items?.[0];
    if (!video) throw new Error('Video not found or is private.');

    return {
      source_type: 'video',
      source_name: video.snippet.title,
      source_channel_id: video.snippet.channelId,
      videos: [{
        video_id: rawId,
        title: video.snippet.title,
        position: 0,
        channel_name: video.snippet.channelTitle,
        duration_seconds: parseDuration(video.contentDetails.duration ?? ''),
      }],
    };
  }

  // ─── Playlist ───
  if (type === 'playlist') {
    // Get playlist metadata
    const metaParams = new URLSearchParams({
      part: 'snippet',
      id: rawId,
      key: apiKey(),
    });
    const metaRes = await fetch(`${YT_API_BASE}/playlists?${metaParams}`);
    const metaData = await metaRes.json();
    const playlistTitle = metaData.items?.[0]?.snippet?.title ?? 'Playlist';

    const { videoIds, titles } = await fetchPlaylistVideos(rawId);
    if (videoIds.length === 0) throw new Error('Playlist is empty or all videos are private.');

    const details = await fetchVideoDetails(videoIds);

    const videos: DiscoveredVideo[] = videoIds.map((id, position) => ({
      video_id: id,
      title: titles.get(id) ?? id,
      position,
      channel_name: details.get(id)?.channelTitle ?? '',
      duration_seconds: details.get(id)?.duration ?? 0,
    }));

    return {
      source_type: 'playlist',
      source_name: playlistTitle,
      source_playlist_id: rawId,
      videos,
    };
  }

  // ─── Channel ───
  const { uploadsPlaylistId, channelTitle, channelId } =
    await resolveChannelUploadsPlaylist(rawId, normalizedUrl);

  const { videoIds, titles } = await fetchPlaylistVideos(uploadsPlaylistId);
  if (videoIds.length === 0) throw new Error('Channel has no public videos.');

  const details = await fetchVideoDetails(videoIds);

  const videos: DiscoveredVideo[] = videoIds.map((id, position) => ({
    video_id: id,
    title: titles.get(id) ?? id,
    position,
    channel_name: channelTitle,
    duration_seconds: details.get(id)?.duration ?? 0,
  }));

  return {
    source_type: 'channel',
    source_name: channelTitle,
    source_channel_id: channelId,
    source_playlist_id: uploadsPlaylistId,
    videos,
  };
}
