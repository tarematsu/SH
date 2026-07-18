const DEFAULT_INITIAL_TRACKS = 22;
const DEFAULT_LOW_WATER_TRACKS = 5;
const DEFAULT_EXPAND_TRACKS = 10;
const MAX_TRACKS = 200;

function integer(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function positiveInteger(value, fallback, maximum = MAX_TRACKS) {
  const parsed = integer(value);
  return parsed != null && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function config(env = {}) {
  return {
    initialTracks: positiveInteger(env.QUEUE_INITIAL_TRACKS, DEFAULT_INITIAL_TRACKS),
    lowWaterTracks: positiveInteger(env.QUEUE_LOW_WATER_TRACKS, DEFAULT_LOW_WATER_TRACKS, 50),
    expandTracks: positiveInteger(env.QUEUE_EXPAND_TRACKS, DEFAULT_EXPAND_TRACKS, 50),
  };
}

function trackKey(track) {
  const isrc = String(track?.isrc || '').trim().toUpperCase();
  if (isrc) return `isrc:${isrc}`;
  const spotifyId = String(track?.spotify_id || '').trim();
  return spotifyId ? `spotify:${spotifyId}` : null;
}

function queueIdentity(queue) {
  return {
    stationId: integer(queue?.station_id),
    queueId: integer(queue?.queue_id),
    startTime: integer(queue?.start_time),
  };
}

function sameGeneration(state, identity, sourceHash) {
  return Boolean(state)
    && integer(state.station_id) === identity.stationId
    && integer(state.queue_id) === identity.queueId
    && integer(state.start_time) === identity.startTime
    && String(state.source_structural_hash || '') === sourceHash;
}

async function installStateTable(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS sh_queue_materialization_state (
      station_id INTEGER PRIMARY KEY,
      queue_id INTEGER,
      start_time INTEGER,
      source_structural_hash TEXT NOT NULL,
      source_likes_hash TEXT,
      total_track_count INTEGER NOT NULL,
      materialized_count INTEGER NOT NULL,
      requested_count INTEGER NOT NULL,
      last_position INTEGER,
      observed_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`).run();
}

async function loadState(db, stationId) {
  if (!db?.prepare || stationId == null) return null;
  try {
    return await db.prepare(`SELECT station_id,queue_id,start_time,source_structural_hash,
      source_likes_hash,total_track_count,materialized_count,requested_count,last_position,
      observed_at,updated_at
      FROM sh_queue_materialization_state WHERE station_id=?`).bind(stationId).first();
  } catch (error) {
    if (!/no such table/i.test(String(error?.message || ''))) throw error;
    await installStateTable(db);
    return null;
  }
}

export function chooseMaterializedTrackCount(queue, analysis, state = null, env = {}) {
  const total = Array.isArray(queue?.tracks) ? queue.tracks.length : 0;
  if (total <= 0) return 0;
  const cfg = config(env);
  const identity = queueIdentity(queue);
  const sourceHash = String(analysis?.structural_hash || '');
  const requested = sameGeneration(state, identity, sourceHash)
    ? positiveInteger(state.requested_count, cfg.initialTracks)
    : cfg.initialTracks;
  return Math.min(total, Math.max(cfg.initialTracks, requested));
}

function visibleLikeAnalysis(tracks, fullLikes) {
  const keys = new Set((tracks || []).map(trackKey).filter(Boolean));
  const payload = Array.isArray(fullLikes?.payload)
    ? fullLikes.payload.filter((entry) => keys.has(String(entry?.track_key || '')))
    : [];
  return {
    complete: fullLikes?.complete !== false,
    payload,
  };
}

export function materializeQueueWindow(queue, analysis, requestedCount) {
  if (!queue || !analysis?.structural_hash) return { queue, analysis };
  const fullTracks = Array.isArray(queue.tracks) ? queue.tracks : [];
  const totalTrackCount = fullTracks.length;
  const materializedCount = Math.min(
    totalTrackCount,
    Math.max(0, integer(requestedCount) ?? DEFAULT_INITIAL_TRACKS),
  );
  const tracks = fullTracks.slice(0, materializedCount);
  const sourceStructuralHash = String(analysis.structural_hash);
  const sourceLikesHash = typeof analysis.likes_hash === 'string' ? analysis.likes_hash : null;
  const structuralTracks = Array.isArray(analysis?.structural?.tracks)
    ? analysis.structural.tracks.slice(0, materializedCount)
    : [];
  const materialized = {
    ...queue,
    tracks,
    total_track_count: totalTrackCount,
    materialized_track_count: materializedCount,
    materialization_complete: materializedCount >= totalTrackCount,
    source_structural_hash: sourceStructuralHash,
    source_likes_hash: sourceLikesHash,
  };
  const materializedAnalysis = {
    structural: {
      station_id: analysis.structural?.station_id ?? integer(queue.station_id),
      queue_id: analysis.structural?.queue_id ?? integer(queue.queue_id),
      start_time: analysis.structural?.start_time ?? integer(queue.start_time),
      is_paused: analysis.structural?.is_paused ?? queue.is_paused ?? null,
      total_track_count: totalTrackCount,
      source_structural_hash: sourceStructuralHash,
      tracks: structuralTracks,
    },
    likes: visibleLikeAnalysis(tracks, analysis.likes),
    structural_hash: null,
    likes_hash: null,
    source_structural_hash: sourceStructuralHash,
    source_likes_hash: sourceLikesHash,
    total_track_count: totalTrackCount,
    materialized_track_count: materializedCount,
  };
  return { queue: materialized, analysis: materializedAnalysis };
}

export async function prepareMaterializedQueue(db, queue, analysis, env = {}) {
  if (!queue || !analysis?.structural_hash) return { queue, analysis };
  const identity = queueIdentity(queue);
  const state = await loadState(db, identity.stationId);
  const count = chooseMaterializedTrackCount(queue, analysis, state, env);
  return materializeQueueWindow(queue, analysis, count);
}

export async function recordQueueMaterialization(db, queue, analysis, observedAt = Date.now()) {
  const identity = queueIdentity(queue);
  const sourceStructuralHash = String(
    queue?.source_structural_hash || analysis?.source_structural_hash || '',
  );
  const total = positiveInteger(
    queue?.total_track_count ?? analysis?.total_track_count,
    Array.isArray(queue?.tracks) ? queue.tracks.length : 0,
  );
  const materialized = Math.min(
    total,
    positiveInteger(
      queue?.materialized_track_count ?? analysis?.materialized_track_count,
      Array.isArray(queue?.tracks) ? queue.tracks.length : 0,
    ),
  );
  if (!db?.prepare || identity.stationId == null || !sourceStructuralHash || total <= 0) return false;
  try {
    await db.prepare(`INSERT INTO sh_queue_materialization_state(
        station_id,queue_id,start_time,source_structural_hash,source_likes_hash,
        total_track_count,materialized_count,requested_count,last_position,observed_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,NULL,?,?)
      ON CONFLICT(station_id) DO UPDATE SET
        queue_id=excluded.queue_id,start_time=excluded.start_time,
        source_structural_hash=excluded.source_structural_hash,
        source_likes_hash=excluded.source_likes_hash,
        total_track_count=excluded.total_track_count,
        materialized_count=CASE
          WHEN sh_queue_materialization_state.queue_id IS excluded.queue_id
            AND sh_queue_materialization_state.start_time IS excluded.start_time
            AND sh_queue_materialization_state.source_structural_hash=excluded.source_structural_hash
          THEN MAX(sh_queue_materialization_state.materialized_count,excluded.materialized_count)
          ELSE excluded.materialized_count
        END,
        requested_count=CASE
          WHEN sh_queue_materialization_state.queue_id IS excluded.queue_id
            AND sh_queue_materialization_state.start_time IS excluded.start_time
            AND sh_queue_materialization_state.source_structural_hash=excluded.source_structural_hash
          THEN MAX(sh_queue_materialization_state.requested_count,excluded.materialized_count)
          ELSE excluded.materialized_count
        END,
        last_position=CASE
          WHEN sh_queue_materialization_state.queue_id IS excluded.queue_id
            AND sh_queue_materialization_state.start_time IS excluded.start_time
            AND sh_queue_materialization_state.source_structural_hash=excluded.source_structural_hash
          THEN sh_queue_materialization_state.last_position
          ELSE NULL
        END,
        observed_at=MAX(sh_queue_materialization_state.observed_at,excluded.observed_at),
        updated_at=excluded.updated_at
      WHERE excluded.observed_at>=sh_queue_materialization_state.observed_at
        OR (
          sh_queue_materialization_state.queue_id IS excluded.queue_id
          AND sh_queue_materialization_state.start_time IS excluded.start_time
          AND sh_queue_materialization_state.source_structural_hash=excluded.source_structural_hash
        )`)
      .bind(
        identity.stationId,
        identity.queueId,
        identity.startTime,
        sourceStructuralHash,
        queue?.source_likes_hash || analysis?.source_likes_hash || null,
        total,
        materialized,
        materialized,
        integer(observedAt) ?? Date.now(),
        Date.now(),
      ).run();
    return true;
  } catch (error) {
    if (!/no such table/i.test(String(error?.message || ''))) throw error;
    await installStateTable(db);
    return recordQueueMaterialization(db, queue, analysis, observedAt);
  }
}

export function expansionRequest(queue, currentPosition, env = {}) {
  const cfg = config(env);
  const total = positiveInteger(queue?.total_track_count, 0);
  const materialized = positiveInteger(
    queue?.materialized_track_count,
    Array.isArray(queue?.tracks) ? queue.tracks.length : 0,
  );
  const position = integer(currentPosition);
  if (total <= 0 || materialized >= total || position == null || position < 0) return null;
  const remaining = materialized - (position + 1);
  if (remaining > cfg.lowWaterTracks) return null;
  return Math.min(total, Math.max(materialized, position + 1) + cfg.expandTracks);
}

async function updateExpansionRequest(db, queue, requested, currentPosition, observedAt) {
  const identity = queueIdentity(queue);
  const sourceHash = String(queue?.source_structural_hash || '');
  const result = await db.prepare(`UPDATE sh_queue_materialization_state SET
      requested_count=MAX(requested_count,?),last_position=?,
      observed_at=MAX(observed_at,?),updated_at=?
    WHERE station_id=? AND queue_id IS ? AND start_time IS ?
      AND source_structural_hash=?`)
    .bind(
      requested,
      integer(currentPosition),
      integer(observedAt) ?? Date.now(),
      Date.now(),
      identity.stationId,
      identity.queueId,
      identity.startTime,
      sourceHash,
    ).run();
  return Number(result?.meta?.changes || 0) > 0;
}

export async function requestQueueExpansion(db, queue, currentPosition, observedAt = Date.now(), env = {}) {
  const requested = expansionRequest(queue, currentPosition, env);
  const identity = queueIdentity(queue);
  const sourceHash = String(queue?.source_structural_hash || '');
  if (!db?.prepare || requested == null || identity.stationId == null || !sourceHash) return null;
  try {
    if (await updateExpansionRequest(db, queue, requested, currentPosition, observedAt)) return requested;
    const state = await loadState(db, identity.stationId);
    if (state && !sameGeneration(state, identity, sourceHash)) return null;
    // Persistence and playback use different Queues. If playback wins the race,
    // establish the absent state row from its compact queue and then apply it.
    if (!state) await recordQueueMaterialization(db, queue, null, observedAt);
    return await updateExpansionRequest(db, queue, requested, currentPosition, observedAt)
      ? requested
      : null;
  } catch (error) {
    if (!/no such table/i.test(String(error?.message || ''))) throw error;
    await installStateTable(db);
    await recordQueueMaterialization(db, queue, null, observedAt);
    return await updateExpansionRequest(db, queue, requested, currentPosition, observedAt)
      ? requested
      : null;
  }
}

export const QUEUE_MATERIALIZATION_DEFAULTS = Object.freeze({
  initial_tracks: DEFAULT_INITIAL_TRACKS,
  low_water_tracks: DEFAULT_LOW_WATER_TRACKS,
  expand_tracks: DEFAULT_EXPAND_TRACKS,
});
