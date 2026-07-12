import crypto from 'node:crypto';

export function positiveNumber(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

export function nonNegativeNumber(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be zero or greater`);
  return value;
}

export function boolEnv(name, fallback = true) {
  return String(process.env[name] ?? fallback).toLowerCase() === 'true';
}

export function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

export function parsePusherData(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

export function sha256(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
}

export function deriveHostIngestUrl(ingestUrl) {
  if (process.env.HOST_INGEST_URL) return process.env.HOST_INGEST_URL;
  const url = new URL(ingestUrl);
  url.pathname = url.pathname.replace(/\/api\/ingest\/?$/, '/api/host-ingest');
  if (!url.pathname.endsWith('/api/host-ingest')) {
    throw new Error('HOST_INGEST_URL is required because INGEST_URL does not end with /api/ingest');
  }
  return url.toString();
}

export function normalizeProfile(account, fallbackHandle) {
  if (!account) return null;
  return {
    handle: String(account.handle || fallbackHandle || '').trim(),
    account_id: Number(account.id) || null,
    followers: Number.isFinite(Number(account.followers)) ? Number(account.followers) : null,
    following: Number.isFinite(Number(account.following)) ? Number(account.following) : null,
    total_streams: Number.isFinite(Number(account.total_streams)) ? Number(account.total_streams) : null,
    active_stream_days: Number.isFinite(Number(account.active_stream_days)) ? Number(account.active_stream_days) : null,
    emoji: account.emoji ?? null,
    thumbnail_url: account.thumbnail?.url ?? null,
    medium_url: account.medium?.url ?? null,
    main_url: account.main?.url ?? null,
    badges: Array.isArray(account.badges) ? account.badges : [],
    raw: account,
  };
}

export { normalizeComments } from 'sh-shared';

export function normalizeQueue(station, observedAt) {
  const queue = station?.queue;
  if (!queue) return null;
  const items = queue.queue_tracks || queue.tracks || [];
  const tracks = items.map((item, position) => {
    const track = item?.track || item;
    return {
      position,
      queue_track_id: item?.id ?? null,
      stationhead_track_id: track?.id ?? null,
      spotify_id: track?.spotify_id ?? null,
      apple_music_id: track?.apple_music_id ?? null,
      deezer_id: track?.deezer_id ?? null,
      isrc: track?.isrc ?? null,
      duration_ms: track?.duration ?? null,
      preview_url: track?.preview ?? null,
      bite_count: track?.bite_count ?? track?.biteCount ?? track?.likes ?? track?.like_count ?? null,
      raw: item,
    };
  });

  let currentTrack = null;
  const startTime = Number(queue.start_time);
  if (Number.isFinite(startTime) && tracks.length) {
    let elapsed = Math.max(0, observedAt - startTime);
    for (const track of tracks) {
      const duration = Number(track.duration_ms);
      if (!Number.isFinite(duration) || duration <= 0 || elapsed < duration) {
        currentTrack = track;
        break;
      }
      elapsed -= duration;
    }
  }

  return {
    station_id: Number(station?.id) || Number(station?.broadcast?.station_id) || null,
    queue_id: Number(queue.id) || null,
    start_time: Number(queue.start_time) || null,
    is_paused: queue.is_paused ?? null,
    current_track_id: currentTrack?.stationhead_track_id ?? null,
    current_spotify_id: currentTrack?.spotify_id ?? null,
    tracks,
    raw: queue,
  };
}

export function stationIdentity(station) {
  const stationId = Number(firstDefined(station?.id, station?.broadcast?.station_id)) || null;
  const broadcast = station?.broadcast || {};
  const host = broadcast?.broadcasters?.find((item) => item?.is_host)
    || broadcast?.broadcasters?.[0]
    || null;
  return {
    station_id: stationId,
    broadcast_id: Number(broadcast?.id) || null,
    broadcast_stream_id: broadcast?.stream_id ?? null,
    broadcast_start_time: Number(broadcast?.start_time) || null,
    account_id: Number(firstDefined(station?.owner_id, host?.account_id, host?.account?.id)) || null,
    host_handle: station?.owner?.handle ?? host?.account?.handle ?? null,
    channel_id: Number(station?.channel?.id) || null,
    channel_alias: station?.channel?.alias ?? null,
  };
}
