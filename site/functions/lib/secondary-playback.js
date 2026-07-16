import { num, stripAppleMusicFields } from './api-utils.js';
import { normalizePlaybackTrack } from './playback.js';

const SECONDARY_STALE_MS = 4 * 60 * 60_000;
const BUDDY_METADATA_TABLE = 'sh_buddy_track_metadata';

export const SECONDARY_PLAYBACK_SQL = `SELECT p.channel_alias,p.station_id,p.queue_id,p.start_time,
  p.is_paused,p.is_broadcasting,p.host_account_id,p.host_handle,p.state_hash,p.queue_json,
  p.checked_at,p.changed_at,c.paused_total_ms,c.pause_started_at,
  c.observed_at AS clock_observed_at
FROM sh_playback_channel_current p
LEFT JOIN sh_buddy_playback_clock c ON c.channel_alias=p.channel_alias
WHERE p.channel_alias=? LIMIT 1`;

function storedBoolean(value) {
  if (value === true || value === 1) return true;
  if (value === false || value === 0 || value == null || value === '') return false;
  return ['true', '1', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function parseQueueJson(value) {
  if (!value) return [];
  try { return JSON.parse(value); } catch { return null; }
}

function rawQueue(payload) {
  return payload?.current_station?.queue || payload?.queue || null;
}

function firstText(...values) {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text && text !== '[object Object]') return text;
  }
  return null;
}

function normalizedIsrc(value) {
  return String(value || '').trim().toUpperCase();
}

function trackArtist(track) {
  const artist = track?.artist || track?.artists?.[0] || null;
  return firstText(
    typeof artist === 'string' ? artist : artist?.name,
    track?.artist_name,
  );
}

function trackThumbnail(item, track) {
  return firstText(
    track?.thumbnail_url,
    track?.image_url,
    track?.album_art_url,
    track?.artwork_url,
    track?.album?.thumbnail_url,
    track?.album?.image_url,
    track?.album?.artwork_url,
    track?.album?.images?.[0]?.url,
    item?.thumbnail_url,
    item?.image_url,
    item?.album_art_url,
    item?.artwork_url,
  );
}

function metadataForTrack(metadata, row) {
  const isrc = normalizedIsrc(row?.isrc);
  const spotifyId = String(row?.spotify_id || '').trim();
  return (isrc ? metadata.get(`isrc:${isrc}`) : null)
    || (spotifyId ? metadata.get(`spotify:${spotifyId}`) : null)
    || (spotifyId ? metadata.get(spotifyId) : null)
    || null;
}

function applyMetadata(row, metadata = new Map()) {
  const meta = metadataForTrack(metadata, row);
  if (!meta) return row;
  return {
    ...row,
    title: row.title || meta.title || null,
    artist: row.artist || meta.artist || null,
    display_title: row.display_title || meta.display_title || null,
    thumbnail_url: row.thumbnail_url || meta.thumbnail_url || null,
    spotify_url: row.spotify_url || meta.spotify_url || null,
    metadata_fetched_at: row.metadata_fetched_at || meta.fetched_at || null,
    metadata_raw_json: row.metadata_raw_json || meta.raw_json || null,
  };
}

function rawTrackToPlaybackRow(item, index, startTime) {
  const track = item?.track || item || {};
  const spotifyId = String(track.spotify_id || item?.spotify_id || '').trim() || null;
  return stripAppleMusicFields({
    start_time: startTime,
    position: num(item?.position) ?? index,
    spotify_id: spotifyId,
    isrc: normalizedIsrc(track?.isrc ?? item?.isrc) || null,
    duration_ms: num(track?.duration_ms ?? track?.duration),
    bite_count: num(track?.bite_count ?? item?.bite_count),
    title: firstText(track?.title, track?.name),
    artist: trackArtist(track),
    album_name: firstText(track?.album?.name, track?.album_name),
    display_title: track?.display_title || null,
    thumbnail_url: trackThumbnail(item, track),
    spotify_url: track?.spotify_url || null,
  });
}

function queueTracksFromParsed(parsed) {
  if (Array.isArray(parsed)) return parsed;
  const queue = rawQueue(parsed);
  if (Array.isArray(queue?.queue_tracks)) return queue.queue_tracks;
  if (Array.isArray(queue?.tracks)) return queue.tracks;
  return [];
}

export async function loadSecondaryPlaybackMetadata(db, row) {
  const parsed = parseQueueJson(row?.queue_json);
  const tracks = queueTracksFromParsed(parsed);
  const spotifyIds = [];
  const isrcs = [];
  for (const item of tracks) {
    const track = item?.track || item || {};
    const spotifyId = String(track?.spotify_id ?? item?.spotify_id ?? '').trim();
    const isrc = normalizedIsrc(track?.isrc ?? item?.isrc);
    if (spotifyId) spotifyIds.push(spotifyId);
    if (isrc) isrcs.push(isrc);
  }
  const uniqueSpotifyIds = [...new Set(spotifyIds)].slice(0, 100);
  const uniqueIsrcs = [...new Set(isrcs)].slice(0, 100);
  if (!uniqueSpotifyIds.length && !uniqueIsrcs.length) return new Map();

  const clauses = [];
  const bindings = [];
  if (uniqueSpotifyIds.length) {
    clauses.push(`spotify_id IN (${uniqueSpotifyIds.map(() => '?').join(',')})`);
    bindings.push(...uniqueSpotifyIds);
  }
  if (uniqueIsrcs.length) {
    clauses.push(`isrc IN (${uniqueIsrcs.map(() => '?').join(',')})`);
    bindings.push(...uniqueIsrcs);
  }

  let result;
  try {
    result = await db.prepare(`SELECT spotify_id,isrc,title,artist,display_title,
        thumbnail_url,spotify_url,fetched_at,raw_json
      FROM ${BUDDY_METADATA_TABLE}
      WHERE ${clauses.join(' OR ')}
      ORDER BY fetched_at DESC`).bind(...bindings).all();
  } catch (error) {
    if (/no such table:\s*sh_buddy_track_metadata/i.test(String(error?.message || error))) return new Map();
    throw error;
  }

  const metadata = new Map();
  for (const value of result.results || []) {
    const spotifyId = String(value?.spotify_id || '').trim();
    const isrc = normalizedIsrc(value?.isrc);
    if (spotifyId) {
      if (!metadata.has(spotifyId)) metadata.set(spotifyId, value);
      if (!metadata.has(`spotify:${spotifyId}`)) metadata.set(`spotify:${spotifyId}`, value);
    }
    if (isrc && !metadata.has(`isrc:${isrc}`)) metadata.set(`isrc:${isrc}`, value);
  }
  return metadata;
}

function computeSecondaryPlayback(rows, row, generatedAt, paused) {
  if (!rows.length) {
    return { currentIndex: -1, progressMs: 0, anchorAt: null, queueEndAt: null, ended: false };
  }
  const startTime = num(row?.start_time);
  if (startTime == null) {
    return { currentIndex: 0, progressMs: 0, anchorAt: generatedAt, queueEndAt: null, ended: false };
  }

  const pausedTotalMs = Math.max(0, num(row?.paused_total_ms) || 0);
  const pauseStartedAt = num(row?.pause_started_at);
  const effectiveAt = paused
    ? pauseStartedAt ?? num(row?.changed_at) ?? num(row?.checked_at) ?? generatedAt
    : generatedAt;
  const elapsedMs = Math.max(0, effectiveAt - startTime - pausedTotalMs);
  let cursor = 0;
  let totalDurationMs = 0;
  let currentIndex = -1;
  let progressMs = 0;

  for (let index = 0; index < rows.length; index += 1) {
    const durationMs = Math.max(0, num(rows[index]?.duration_ms) || 0);
    if (currentIndex < 0 && (elapsedMs < cursor + durationMs || index === rows.length - 1)) {
      currentIndex = index;
      progressMs = Math.max(0, Math.min(durationMs, elapsedMs - cursor));
    }
    cursor += durationMs;
    totalDurationMs += durationMs;
  }

  if (totalDurationMs <= 0) {
    return { currentIndex: 0, progressMs: 0, anchorAt: effectiveAt, queueEndAt: null, ended: false };
  }
  const ended = !paused && elapsedMs >= totalDurationMs;
  if (ended) {
    return { currentIndex: -1, progressMs: 0, anchorAt: null, queueEndAt: generatedAt, ended: true };
  }
  return {
    currentIndex,
    progressMs,
    anchorAt: effectiveAt - progressMs,
    queueEndAt: paused ? null : generatedAt + Math.max(0, totalDurationMs - elapsedMs),
    ended: false,
  };
}

function visiblePlaybackState(rows, row, generatedAt, stale, paused) {
  const playback = computeSecondaryPlayback(rows, row, generatedAt, paused);
  return {
    ended: playback.ended,
    visiblePlayback: stale
      ? { ...playback, currentIndex: -1, progressMs: 0, anchorAt: null }
      : playback,
  };
}

function playbackStatus({ paused, playing, ended, playback, totalItems }) {
  const status = {
    is_paused: paused,
    playing,
    current_index: playback.currentIndex,
    progress_ms: playback.progressMs,
    anchor_at: playback.anchorAt,
    total_items: totalItems,
  };
  if (ended) status.ended = true;
  if (playback.queueEndAt != null) status.queue_end_at = playback.queueEndAt;
  return status;
}

export function emptySecondaryPayload(alias, generatedAt, setupRequired = false) {
  return {
    ok: true,
    channel_alias: alias || null,
    generated_at: generatedAt,
    latest_observed_at: null,
    queue_observed_at: null,
    changed_at: null,
    station_id: null,
    is_broadcasting: false,
    host_account_id: null,
    host_handle: null,
    playing: false,
    stale: true,
    setup_required: setupRequired,
    queue_revision: null,
    queue_status: null,
    queue: [],
  };
}

function secondaryRawPlaybackPayload(row, rawPayload, generatedAt, options) {
  const alias = String(row?.channel_alias || '').trim() || null;
  const checkedAt = num(row.checked_at);
  const changedAt = num(row.changed_at);
  const queueSource = rawQueue(rawPayload);
  const stationId = num(row.station_id ?? queueSource?.station_id ?? rawPayload?.station_id ?? rawPayload?.id);
  const startTime = num(row.start_time ?? queueSource?.start_time);
  const paused = storedBoolean(row.is_paused ?? queueSource?.is_paused);
  const broadcasting = storedBoolean(row.is_broadcasting ?? rawPayload?.is_broadcasting);
  const sourceTracks = Array.isArray(queueSource?.queue_tracks)
    ? queueSource.queue_tracks
    : Array.isArray(queueSource?.tracks)
      ? queueSource.tracks
      : [];
  const rows = sourceTracks
    .map((track, index) => rawTrackToPlaybackRow(track, index, startTime))
    .map((track) => applyMetadata(track, options.metadata));
  const stale = checkedAt == null || generatedAt - checkedAt > SECONDARY_STALE_MS;
  const { ended, visiblePlayback } = visiblePlaybackState(rows, row, generatedAt, stale, paused);
  const queue = rows.map((track, index) => normalizePlaybackTrack(track, index, visiblePlayback));
  const playing = !stale && broadcasting && !paused && !ended && visiblePlayback.currentIndex >= 0;
  const payload = {
    ok: true,
    channel_alias: alias,
    generated_at: generatedAt,
    latest_observed_at: checkedAt,
    queue_observed_at: checkedAt,
    changed_at: changedAt,
    station_id: stationId,
    is_broadcasting: broadcasting,
    host_account_id: num(row.host_account_id),
    host_handle: row.host_handle || null,
    playing,
    stale,
    raw_payload_mode: true,
    setup_required: false,
    queue_revision: row.state_hash || null,
    queue_status: playbackStatus({ paused, playing, ended, playback: visiblePlayback, totalItems: queue.length }),
    queue,
  };
  if (options.includeRawPayload) payload.raw_payload = rawPayload;
  return payload;
}

export function secondaryPlaybackPayload(row, generatedAt = Date.now(), options = {}) {
  const alias = String(row?.channel_alias || '').trim() || null;
  if (!row) return emptySecondaryPayload(alias, generatedAt);

  const checkedAt = num(row.checked_at);
  const changedAt = num(row.changed_at);
  const startTime = num(row.start_time);
  const parsed = parseQueueJson(row.queue_json);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return secondaryRawPlaybackPayload(row, parsed, generatedAt, {
      includeRawPayload: Boolean(options.includeRawPayload),
      metadata: options.metadata || new Map(),
    });
  }

  const queueCorrupt = parsed === null || !Array.isArray(parsed);
  const source = Array.isArray(parsed) ? parsed : [];
  const rows = source.map((track, index) => applyMetadata(stripAppleMusicFields({
    ...track,
    start_time: startTime,
    position: num(track?.position) ?? index,
  }), options.metadata || new Map()));
  const paused = storedBoolean(row.is_paused);
  const broadcasting = storedBoolean(row.is_broadcasting);
  const stale = queueCorrupt || checkedAt == null || generatedAt - checkedAt > SECONDARY_STALE_MS;
  const { ended, visiblePlayback } = visiblePlaybackState(rows, row, generatedAt, stale, paused);
  const queue = rows.map((track, index) => stripAppleMusicFields(
    normalizePlaybackTrack(track, index, visiblePlayback),
  ));
  const playing = !stale && broadcasting && !paused && !ended && visiblePlayback.currentIndex >= 0;

  return {
    ok: true,
    channel_alias: alias,
    generated_at: generatedAt,
    latest_observed_at: checkedAt,
    queue_observed_at: checkedAt,
    changed_at: changedAt,
    station_id: num(row.station_id),
    is_broadcasting: broadcasting,
    host_account_id: num(row.host_account_id),
    host_handle: row.host_handle || null,
    playing,
    stale,
    queue_corrupt: queueCorrupt,
    setup_required: false,
    queue_revision: row.state_hash || null,
    queue_status: playbackStatus({ paused, playing, ended, playback: visiblePlayback, totalItems: queue.length }),
    queue,
  };
}
