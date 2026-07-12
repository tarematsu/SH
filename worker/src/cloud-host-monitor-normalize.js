import { normalizeComments as sharedNormalizeComments } from './shared.js';

export function finite(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function identity(station) {
  const broadcast = station?.broadcast || {};
  const host = broadcast?.broadcasters?.find((item) => item?.is_host)
    || broadcast?.broadcasters?.[0]
    || null;
  return {
    stationId: finite(station?.id ?? broadcast?.station_id),
    broadcastId: finite(broadcast?.id),
    broadcastStreamId: broadcast?.stream_id ?? null,
    broadcastStartTime: finite(broadcast?.start_time),
    accountId: finite(station?.owner_id ?? host?.account_id ?? host?.account?.id),
    hostHandle: station?.owner?.handle ?? host?.account?.handle ?? null,
    channelId: finite(station?.channel?.id),
    channelAlias: station?.channel?.alias ?? null,
  };
}

export function normalizeProfile(account, fallbackHandle) {
  if (!account) return null;
  return {
    handle: String(account.handle || fallbackHandle || '').trim(),
    account_id: finite(account.id),
    followers: finite(account.followers),
    following: finite(account.following),
    total_streams: finite(account.total_streams),
    active_stream_days: finite(account.active_stream_days),
    emoji: account.emoji ?? null,
    thumbnail_url: account.thumbnail?.url ?? null,
    medium_url: account.medium?.url ?? null,
    main_url: account.main?.url ?? null,
    badges: Array.isArray(account.badges) ? account.badges : [],
    raw: account,
  };
}

export function normalizeComments(payload, stationId) {
  return sharedNormalizeComments(payload, stationId, { finite });
}

export function normalizeQueue(station, observedAt) {
  const queue = station?.queue;
  if (!queue) return null;
  const items = queue.queue_tracks || queue.tracks || [];
  const tracks = items.map((item, position) => {
    const track = item?.track || item;
    return {
      position,
      queue_track_id: finite(item?.id),
      stationhead_track_id: finite(track?.id),
      spotify_id: track?.spotify_id ?? null,
      apple_music_id: track?.apple_music_id ?? null,
      deezer_id: track?.deezer_id ?? null,
      isrc: track?.isrc ?? null,
      duration_ms: finite(track?.duration),
      preview_url: track?.preview ?? null,
      bite_count: finite(track?.bite_count ?? track?.biteCount ?? track?.likes ?? track?.like_count),
      raw: item,
    };
  });

  let currentTrack = null;
  const startTime = finite(queue.start_time);
  if (startTime != null && tracks.length) {
    let elapsed = Math.max(0, observedAt - startTime);
    for (const track of tracks) {
      const duration = finite(track.duration_ms);
      if (!duration || elapsed < duration) {
        currentTrack = track;
        break;
      }
      elapsed -= duration;
    }
    if (!currentTrack) currentTrack = tracks.at(-1);
  }

  return {
    station_id: finite(station?.id ?? station?.broadcast?.station_id),
    queue_id: finite(queue.id),
    start_time: startTime,
    is_paused: queue.is_paused ?? null,
    current_track_id: currentTrack?.stationhead_track_id ?? null,
    current_spotify_id: currentTrack?.spotify_id ?? null,
    tracks,
    raw: queue,
  };
}

export async function digest(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((part) => part.toString(16).padStart(2, '0')).join('');
}

export async function queueHash(queue) {
  return digest({
    start_time: queue.start_time,
    is_paused: queue.is_paused,
    tracks: queue.tracks.map((track) => [
      track.queue_track_id,
      track.stationhead_track_id,
      track.spotify_id,
      track.duration_ms,
    ]),
  });
}
