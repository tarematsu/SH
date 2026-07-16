import { num, stripAppleMusicFields } from './api-utils.js';
import { computePlayback, normalizePlaybackTrack } from './playback.js';

const SECONDARY_STALE_MS = 4 * 60 * 60_000;

export const SECONDARY_PLAYBACK_SQL = `SELECT channel_alias,station_id,queue_id,start_time,
  is_paused,is_broadcasting,host_account_id,host_handle,state_hash,queue_json,
  checked_at,changed_at
FROM sh_playback_channel_current WHERE channel_alias=? LIMIT 1`;

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
    if (text) return text;
  }
  return null;
}

function trackThumbnail(item, track) {
  return firstText(
    track?.thumbnail_url,
    track?.image_url,
    track?.album_art_url,
    track?.artwork_url,
    track?.album?.thumbnail_url,
    track?.album?.image_url,
    track?.album?.images?.[0]?.url,
    item?.thumbnail_url,
    item?.image_url,
    item?.album_art_url,
    item?.artwork_url,
  );
}

function applyMetadata(row, metadata = new Map()) {
  const spotifyId = String(row?.spotify_id || '').trim();
  const meta = spotifyId ? metadata.get(spotifyId) : null;
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
    position: index,
    spotify_id: spotifyId,
    duration_ms: num(track?.duration_ms ?? track?.duration),
    bite_count: num(track?.bite_count ?? item?.bite_count),
    title: track?.title || track?.name || null,
    artist: track?.artist || track?.artist_name || null,
    display_title: track?.display_title || null,
    thumbnail_url: trackThumbnail(item, track),
    spotify_url: track?.spotify_url || null,
  });
}

function visiblePlaybackState(rows, playbackAt, stale, paused = false) {
  const computed = computePlayback(rows, playbackAt);
  const ended = !paused
    && computed.queueEndAt != null
    && playbackAt >= computed.queueEndAt
    && rows.length > 0;
  const playback = ended
    ? { ...computed, currentIndex: -1, progressMs: 0, anchorAt: null }
    : computed;
  return {
    ended,
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
  const playbackAt = paused ? changedAt ?? checkedAt ?? generatedAt : generatedAt;
  const stale = checkedAt == null || generatedAt - checkedAt > SECONDARY_STALE_MS;
  const { ended, visiblePlayback } = visiblePlaybackState(rows, playbackAt, stale, paused);
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
  const playbackAt = paused ? changedAt ?? checkedAt ?? generatedAt : generatedAt;
  const stale = queueCorrupt || checkedAt == null || generatedAt - checkedAt > SECONDARY_STALE_MS;
  const { ended, visiblePlayback } = visiblePlaybackState(rows, playbackAt, stale, paused);
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
