import { num, stripAppleMusicFields } from './api-utils.js';
import { FACTS_FRESH_MS } from './dashboard-facts.js';
import { normalizePlaybackTrack } from './playback.js';
import { queueFromReadModel, QUEUE_READ_MODEL_SQL } from './public-read-model.js';
import { hostIdentity, queueRevision, stateFromQueue } from './queue-state.js';

const MAX_QUEUE_ITEMS = 100;

export const PRIMARY_PLAYBACK_STATE_SQL = `WITH latest_fact AS (
  SELECT f.id,f.channel_id,f.observed_at,f.is_broadcasting
  FROM sh_minute_facts f
  WHERE f.source_code=1
  ORDER BY f.minute_at DESC,f.id DESC
  LIMIT 1
)
SELECT latest_fact.channel_id,latest_fact.observed_at AS latest_observed_at,
  latest_fact.is_broadcasting,c.station_id AS fact_station_id,
  c.broadcast_start_time,h.stationhead_account_id AS host_account_id,
  h.current_handle AS host_handle,
  p.session_id,p.revision_id,p.queue_start_time,p.is_paused,
  p.paused_total_ms,p.pause_started_at,p.last_observed_at,p.current_position,
  r.station_id AS queue_station_id,r.queue_id,r.structural_hash,r.item_count
FROM latest_fact
LEFT JOIN sh_minute_fact_context c ON c.fact_id=latest_fact.id
LEFT JOIN sh_hosts h ON h.id=c.host_id
LEFT JOIN sh_playback_current p ON p.channel_id=latest_fact.channel_id
LEFT JOIN sh_queue_revisions r ON r.id=p.revision_id
LIMIT 1`;

export const PRIMARY_PLAYBACK_ITEMS_SQL = `SELECT i.position,i.queue_track_id,
  i.stationhead_track_id,i.spotify_id,i.deezer_id,i.isrc,i.duration_ms,
  i.playback_offset_ms,i.schedule_valid,i.bite_count,
  t.title AS canonical_title,t.artist AS canonical_artist
FROM sh_queue_revision_items i
LEFT JOIN sh_tracks t ON t.id=i.track_id
WHERE i.revision_id=?
ORDER BY i.position ASC
LIMIT ${MAX_QUEUE_ITEMS}`;

function text(value) {
  const parsed = String(value ?? '').trim();
  return parsed || null;
}

function integer(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function storedBoolean(value) {
  if (value === true || value === 1) return true;
  if (value === false || value === 0 || value == null || value === '') return false;
  return ['true', '1', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function normalizedIsrc(value) {
  return String(value || '').trim().toUpperCase();
}

function sameQueueIdentity(state, queueRow) {
  if (!state || !queueRow) return false;
  const queueId = integer(state.queue_id);
  const startTime = integer(state.queue_start_time);
  return queueId != null
    && startTime != null
    && queueId === integer(queueRow.queue_id)
    && startTime === integer(queueRow.start_time);
}

function metadataMaps(rows = []) {
  const bySpotifyId = new Map();
  const byIsrc = new Map();
  for (const row of rows) {
    const spotifyId = text(row?.spotify_id);
    const isrc = normalizedIsrc(row?.isrc);
    if (spotifyId && !bySpotifyId.has(spotifyId)) bySpotifyId.set(spotifyId, row);
    if (isrc && !byIsrc.has(isrc)) byIsrc.set(isrc, row);
  }
  return { bySpotifyId, byIsrc };
}

async function loadMetadata(db, tracks) {
  const spotifyIds = [...new Set(tracks.map((track) => text(track?.spotify_id)).filter(Boolean))];
  const isrcs = [...new Set(tracks.map((track) => normalizedIsrc(track?.isrc)).filter(Boolean))];
  if (!spotifyIds.length && !isrcs.length) return [];

  const clauses = [];
  const bindings = [];
  if (isrcs.length) {
    clauses.push(`isrc IN (${isrcs.map(() => '?').join(',')})`);
    bindings.push(...isrcs);
  }
  if (spotifyIds.length) {
    clauses.push(`spotify_id IN (${spotifyIds.map(() => '?').join(',')})`);
    bindings.push(...spotifyIds);
  }

  try {
    const result = await db.prepare(`SELECT spotify_id,isrc,title,artist,display_title,
        thumbnail_url,spotify_url,fetched_at,raw_json
      FROM sh_track_metadata
      WHERE ${clauses.join(' OR ')}
      ORDER BY fetched_at DESC`).bind(...bindings).all();
    return result.results || [];
  } catch (error) {
    if (!/no such column:\s*isrc/i.test(String(error?.message || error)) || !spotifyIds.length) throw error;
    const result = await db.prepare(`SELECT spotify_id,NULL AS isrc,title,artist,display_title,
        thumbnail_url,spotify_url,fetched_at,raw_json
      FROM sh_track_metadata
      WHERE spotify_id IN (${spotifyIds.map(() => '?').join(',')})
      ORDER BY fetched_at DESC`).bind(...spotifyIds).all();
    return result.results || [];
  }
}

function displayRows(queueRow, state) {
  if (!sameQueueIdentity(state, queueRow)) return [];
  return queueFromReadModel(queueRow).queue;
}

function thumbnailFrom(track) {
  return text(
    track?.thumbnail_url
      ?? track?.image_url
      ?? track?.album_art_url
      ?? track?.artwork_url
      ?? track?.album?.thumbnail_url
      ?? track?.album?.image_url
      ?? track?.album?.images?.[0]?.url,
  );
}

export function buildPrimaryPlaybackRows(items = [], queueRow = null, state = {}, metadataRows = []) {
  const display = displayRows(queueRow, state);
  const displayByPosition = new Map(display.map((track, index) => [integer(track?.position) ?? index, track]));
  const source = items.length
    ? items
    : display.map((track, index) => ({
        ...track,
        position: integer(track?.position) ?? index,
        canonical_title: track?.title,
        canonical_artist: track?.artist,
      }));
  const metadata = metadataMaps(metadataRows);
  let fallbackOffset = 0;

  return source.map((item, index) => {
    const position = integer(item?.position) ?? index;
    const live = displayByPosition.get(position) || {};
    const spotifyId = text(item?.spotify_id ?? live?.spotify_id);
    const isrc = normalizedIsrc(item?.isrc ?? live?.isrc);
    const meta = (isrc && metadata.byIsrc.get(isrc))
      || (spotifyId && metadata.bySpotifyId.get(spotifyId))
      || {};
    const durationMs = Math.max(0, num(item?.duration_ms ?? live?.duration_ms) || 0);
    const explicitOffset = num(item?.playback_offset_ms);
    const playbackOffsetMs = explicitOffset == null ? fallbackOffset : Math.max(0, explicitOffset);
    fallbackOffset = Math.max(fallbackOffset, playbackOffsetMs + durationMs);

    return stripAppleMusicFields({
      position,
      queue_track_id: item?.queue_track_id ?? live?.queue_track_id ?? null,
      stationhead_track_id: item?.stationhead_track_id ?? live?.stationhead_track_id ?? null,
      spotify_id: spotifyId,
      deezer_id: item?.deezer_id ?? live?.deezer_id ?? null,
      isrc: isrc || null,
      start_time: integer(state.queue_start_time ?? queueRow?.start_time),
      observed_at: integer(state.last_observed_at ?? queueRow?.observed_at),
      duration_ms: durationMs,
      playback_offset_ms: playbackOffsetMs,
      schedule_valid: integer(item?.schedule_valid) ?? (durationMs > 0 ? 1 : 0),
      bite_count: integer(item?.bite_count ?? live?.bite_count),
      title: text(live?.title) || text(meta?.title) || text(item?.canonical_title),
      artist: text(live?.artist) || text(meta?.artist) || text(item?.canonical_artist),
      album_name: text(live?.album_name),
      display_title: text(live?.display_title) || text(meta?.display_title),
      thumbnail_url: thumbnailFrom(live) || text(meta?.thumbnail_url),
      spotify_url: text(live?.spotify_url) || text(meta?.spotify_url),
      metadata_fetched_at: integer(meta?.fetched_at),
      metadata_raw_json: meta?.raw_json || null,
    });
  });
}

export function computePrimaryPlayback(rows = [], state = {}, generatedAt = Date.now()) {
  if (!rows.length) {
    return { currentIndex: -1, progressMs: 0, anchorAt: null, queueEndAt: null, ended: false };
  }
  const queueStart = integer(state.queue_start_time);
  if (queueStart == null) {
    return { currentIndex: 0, progressMs: 0, anchorAt: generatedAt, queueEndAt: null, ended: false };
  }

  const paused = storedBoolean(state.is_paused);
  const pausedTotalMs = Math.max(0, integer(state.paused_total_ms) || 0);
  const pauseStartedAt = integer(state.pause_started_at);
  const effectiveAt = paused && pauseStartedAt != null
    ? Math.min(generatedAt, pauseStartedAt)
    : generatedAt;
  const elapsedMs = Math.max(0, effectiveAt - queueStart - pausedTotalMs);
  let totalDurationMs = 0;
  let currentIndex = -1;
  let progressMs = 0;

  for (let index = 0; index < rows.length; index += 1) {
    const offset = Math.max(0, num(rows[index]?.playback_offset_ms) || totalDurationMs);
    const duration = Math.max(0, num(rows[index]?.duration_ms) || 0);
    totalDurationMs = Math.max(totalDurationMs, offset + duration);
    if (currentIndex < 0 && duration > 0 && elapsedMs >= offset && elapsedMs < offset + duration) {
      currentIndex = index;
      progressMs = Math.max(0, Math.min(duration, elapsedMs - offset));
    }
  }

  if (totalDurationMs <= 0) {
    const savedPosition = integer(state.current_position);
    currentIndex = savedPosition != null && savedPosition >= 0 && savedPosition < rows.length
      ? savedPosition
      : 0;
    return {
      currentIndex,
      progressMs: 0,
      anchorAt: effectiveAt,
      queueEndAt: null,
      ended: false,
    };
  }

  const ended = elapsedMs >= totalDurationMs;
  if (ended) {
    return {
      currentIndex: -1,
      progressMs: 0,
      anchorAt: null,
      queueEndAt: effectiveAt,
      ended: true,
    };
  }

  if (currentIndex < 0) currentIndex = 0;
  return {
    currentIndex,
    progressMs,
    anchorAt: effectiveAt - progressMs,
    queueEndAt: generatedAt + Math.max(0, totalDurationMs - elapsedMs),
    ended: false,
  };
}

function emptyPayload(generatedAt, state = null) {
  return {
    ok: true,
    channel_alias: 'buddies',
    generated_at: generatedAt,
    latest_observed_at: integer(state?.latest_observed_at ?? state?.observed_at),
    queue_observed_at: integer(state?.last_observed_at),
    changed_at: integer(state?.pause_started_at),
    station_id: integer(state?.queue_station_id ?? state?.fact_station_id ?? state?.station_id),
    is_broadcasting: storedBoolean(state?.is_broadcasting),
    host_account_id: integer(state?.host_account_id),
    host_handle: text(state?.host_handle),
    playing: false,
    stale: true,
    setup_required: false,
    queue_revision: null,
    queue_status: null,
    queue: [],
  };
}

export async function loadPrimaryPlaybackPayload(db, generatedAt = Date.now()) {
  const state = await db.prepare(PRIMARY_PLAYBACK_STATE_SQL).first();
  if (!state) return emptyPayload(generatedAt);

  const channelId = integer(state.channel_id);
  const revisionId = integer(state.revision_id);
  const [itemsResult, queueRow] = await Promise.all([
    revisionId == null
      ? Promise.resolve({ results: [] })
      : db.prepare(PRIMARY_PLAYBACK_ITEMS_SQL).bind(revisionId).all(),
    channelId == null
      ? Promise.resolve(null)
      : db.prepare(QUEUE_READ_MODEL_SQL).bind(channelId).first(),
  ]);
  const effectiveState = {
    ...state,
    latest_observed_at: state.latest_observed_at ?? state.observed_at,
    fact_station_id: state.fact_station_id ?? state.station_id,
    queue_station_id: state.queue_station_id ?? queueRow?.station_id,
    queue_id: state.queue_id ?? queueRow?.queue_id,
    queue_start_time: state.queue_start_time ?? queueRow?.start_time,
    is_paused: state.is_paused ?? queueRow?.is_paused,
    paused_total_ms: state.paused_total_ms ?? 0,
    pause_started_at: state.pause_started_at
      ?? (storedBoolean(queueRow?.is_paused) ? queueRow?.observed_at : null),
    last_observed_at: state.last_observed_at ?? queueRow?.observed_at,
  };
  const items = itemsResult.results || [];
  const metadataRows = await loadMetadata(db, [
    ...items,
    ...displayRows(queueRow, effectiveState),
  ]);
  const rows = buildPrimaryPlaybackRows(items, queueRow, effectiveState, metadataRows);
  if (!rows.length) return emptyPayload(generatedAt, effectiveState);

  const playback = computePrimaryPlayback(rows, effectiveState, generatedAt);
  const latestObservedAt = integer(effectiveState.latest_observed_at);
  const queueObservedAt = integer(effectiveState.last_observed_at);
  const freshestAt = Math.max(latestObservedAt || 0, queueObservedAt || 0) || null;
  const stale = freshestAt == null || generatedAt - freshestAt > FACTS_FRESH_MS;
  const paused = storedBoolean(effectiveState.is_paused);
  const broadcasting = storedBoolean(effectiveState.is_broadcasting);
  const playing = !stale && broadcasting && !paused && !playback.ended && playback.currentIndex >= 0;
  const latestQueue = {
    station_id: integer(effectiveState.queue_station_id ?? effectiveState.fact_station_id),
    queue_id: integer(effectiveState.queue_id),
    start_time: integer(effectiveState.queue_start_time),
    is_paused: paused ? 1 : 0,
    observed_at: queueObservedAt,
    structural_hash: effectiveState.structural_hash || '',
    likes_hash: '',
  };
  const latest = {
    station_id: latestQueue.station_id,
    host_account_id: integer(effectiveState.host_account_id),
    host_handle: text(effectiveState.host_handle),
  };
  const revision = queueRevision(stateFromQueue(latestQueue, rows), hostIdentity(latest));
  const queue = rows.map((track, index) => normalizePlaybackTrack(track, index, playback));
  const queueStatus = {
    is_paused: paused,
    playing,
    current_index: playback.currentIndex,
    progress_ms: playback.progressMs,
    anchor_at: playback.anchorAt,
    total_items: queue.length,
  };
  if (playback.ended) queueStatus.ended = true;
  if (playback.queueEndAt != null) queueStatus.queue_end_at = playback.queueEndAt;

  return {
    ok: true,
    channel_alias: 'buddies',
    generated_at: generatedAt,
    latest_observed_at: latestObservedAt,
    queue_observed_at: queueObservedAt,
    changed_at: integer(effectiveState.pause_started_at),
    station_id: latestQueue.station_id,
    is_broadcasting: broadcasting,
    host_account_id: latest.host_account_id,
    host_handle: latest.host_handle,
    playing,
    stale,
    setup_required: false,
    queue_revision: revision,
    queue_status: queueStatus,
    queue,
  };
}
