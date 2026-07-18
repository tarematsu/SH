import { sanitizeFailureDetail } from './collector-failure.js';
import {
  attachReadModelTrackMetadata,
  loadReadModelTrackMetadata,
} from './minute-facts-read-model.js';

const DEFAULT_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 500;
const DEFAULT_SOURCE_LAG_MS = 5 * 60_000;
const SYNC_KEYS = Object.freeze(['track-likes', 'track-metadata']);

function integer(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function text(value) {
  if (value == null || value === '') return null;
  const result = String(value).trim();
  return result || null;
}

function positive(value, fallback, maximum) {
  const parsed = integer(value);
  if (parsed == null || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

function sourceCutoff(now, env) {
  const configured = integer(env?.BUDDIES_SYNC_SOURCE_LAG_MS);
  const lag = configured == null || configured < 0
    ? DEFAULT_SOURCE_LAG_MS
    : configured;
  return now - lag;
}

function cursor(state) {
  return {
    observedAt: integer(state?.cursor_observed_at) || 0,
    sourceId: integer(state?.cursor_source_id) || 0,
    sourceText: text(state?.cursor_source_text) || '',
  };
}

async function loadState(db, syncKey) {
  return db.prepare('SELECT * FROM sh_buddies_sync_state WHERE sync_key=?')
    .bind(syncKey).first();
}

function saveStateStatement(db, syncKey, values = {}) {
  return db.prepare(`UPDATE sh_buddies_sync_state SET
      cursor_observed_at=?,cursor_source_id=?,cursor_source_text=?,
      rows_processed=rows_processed+?,last_run_at=?,last_success_at=?,last_error=?,updated_at=?
    WHERE sync_key=?`).bind(
    integer(values.cursorObservedAt) || 0,
    integer(values.cursorSourceId) || 0,
    text(values.cursorSourceText),
    integer(values.rowsProcessed) || 0,
    values.lastRunAt ?? Date.now(),
    values.lastSuccessAt ?? Date.now(),
    values.lastError ?? null,
    Date.now(),
    syncKey,
  );
}

function likeStatement(db, row) {
  const stationId = integer(row.station_id);
  const queueId = integer(row.queue_id);
  const startTime = integer(row.start_time);
  const position = integer(row.position);
  const trackKey = text(row.track_key) || text(row.spotify_id) || text(row.isrc)
    || `source:${integer(row.id) || 0}`;
  const occurrenceKey = `${stationId ?? 0}:${queueId ?? 0}:${startTime ?? 0}:${position ?? trackKey}`;
  const count = integer(row.like_count);
  const sourceRecordId = `buddies-like:${integer(row.id) || 0}`;
  return db.prepare(`INSERT INTO sh_track_counter_changes(
      observed_at,occurrence_key,station_id,queue_id,queue_start_time,queue_position,
      queue_track_id,stationhead_track_id,spotify_id,apple_music_id,isrc,
      track_key,count_value,source,source_record_id
    ) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
    WHERE ? IS NOT NULL AND NOT EXISTS(
      SELECT 1 FROM sh_track_counter_changes
      WHERE occurrence_key=? AND count_value=?
    )`).bind(
    integer(row.observed_at), occurrenceKey, stationId, queueId, startTime, position,
    integer(row.queue_track_id), integer(row.stationhead_track_id), text(row.spotify_id),
    text(row.apple_music_id), text(row.isrc), trackKey, count,
    text(row.source) || 'buddies-buffer', sourceRecordId,
    count, occurrenceKey, count,
  );
}

function metadataStatement(db, row) {
  const spotifyId = text(row.spotify_id);
  return db.prepare(`INSERT INTO sh_track_metadata(
      spotify_id,isrc,title,artist,display_title,thumbnail_url,spotify_url,source,fetched_at,raw_json
    ) VALUES(?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(spotify_id) DO UPDATE SET
      isrc=COALESCE(excluded.isrc,sh_track_metadata.isrc),
      title=COALESCE(excluded.title,sh_track_metadata.title),
      artist=COALESCE(excluded.artist,sh_track_metadata.artist),
      display_title=COALESCE(excluded.display_title,sh_track_metadata.display_title),
      thumbnail_url=COALESCE(excluded.thumbnail_url,sh_track_metadata.thumbnail_url),
      spotify_url=COALESCE(excluded.spotify_url,sh_track_metadata.spotify_url),
      source=excluded.source,fetched_at=MAX(excluded.fetched_at,sh_track_metadata.fetched_at),
      raw_json=COALESCE(excluded.raw_json,sh_track_metadata.raw_json)`).bind(
    spotifyId, text(row.isrc), text(row.title), text(row.artist), text(row.display_title),
    text(row.thumbnail_url), text(row.spotify_url), text(row.source) || 'buddies-buffer',
    integer(row.fetched_at), text(row.raw_json),
  );
}

async function readRows(sourceDb, syncKey, state, cutoff, limit) {
  const current = cursor(state);
  if (syncKey === 'track-metadata') {
    return sourceDb.prepare(`SELECT spotify_id,isrc,title,artist,display_title,thumbnail_url,
        spotify_url,source,fetched_at,raw_json
      FROM sh_track_metadata WHERE fetched_at<? AND (
        fetched_at>? OR (fetched_at=? AND spotify_id>?)
      ) ORDER BY fetched_at ASC,spotify_id ASC LIMIT ?`)
      .bind(cutoff, current.observedAt, current.observedAt, current.sourceText, limit).all();
  }
  return sourceDb.prepare(`SELECT * FROM sh_track_like_observations
    WHERE observed_at<? AND (observed_at>? OR (observed_at=? AND id>?))
    ORDER BY observed_at ASC,id ASC LIMIT ?`)
    .bind(cutoff, current.observedAt, current.observedAt, current.sourceId, limit).all();
}

async function syncOne(env, syncKey, now, limit) {
  const sourceDb = env?.DB || env?.BUDDIES_DB;
  const minuteDb = env?.MINUTE_DB;
  if (!sourceDb || !minuteDb) return { syncKey, skipped: true, reason: 'db-binding-missing' };
  const state = await loadState(minuteDb, syncKey);
  if (!state) return { syncKey, skipped: true, reason: 'state-missing' };
  const result = await readRows(sourceDb, syncKey, state, sourceCutoff(now, env), limit);
  const rows = result.results || [];
  if (!rows.length) {
    await minuteDb.prepare(`UPDATE sh_buddies_sync_state SET
        last_run_at=?,last_success_at=?,last_error=NULL,updated_at=? WHERE sync_key=?`)
      .bind(now, now, now, syncKey).run();
    return { syncKey, skipped: false, rows: 0, caught_up: true };
  }
  const statements = new Array(rows.length + 1);
  for (let index = 0; index < rows.length; index += 1) {
    statements[index] = syncKey === 'track-likes'
      ? likeStatement(minuteDb, rows[index])
      : metadataStatement(minuteDb, rows[index]);
  }
  const last = rows[rows.length - 1];
  statements[rows.length] = saveStateStatement(minuteDb, syncKey, {
    cursorObservedAt: integer(last.observed_at ?? last.fetched_at) || 0,
    cursorSourceId: integer(last.id) || 0,
    cursorSourceText: text(last.spotify_id),
    rowsProcessed: rows.length,
    lastRunAt: now,
    lastSuccessAt: now,
  });
  await minuteDb.batch(statements);
  return { syncKey, skipped: false, rows: rows.length, caught_up: rows.length < limit };
}

async function syncOneSafely(env, syncKey, now, limit) {
  try {
    return await syncOne(env, syncKey, now, limit);
  } catch (error) {
    const detail = sanitizeFailureDetail(error?.message || error);
    if (env?.MINUTE_DB) {
      await env.MINUTE_DB.prepare(`UPDATE sh_buddies_sync_state SET
          last_run_at=?,last_error=?,updated_at=? WHERE sync_key=?`)
        .bind(now, detail.slice(0, 800), now, syncKey).run().catch(() => {});
    }
    return { syncKey, skipped: true, reason: 'sync-error', error: detail };
  }
}

function safeQueue(value) {
  try {
    const parsed = JSON.parse(String(value || 'null'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function incompletePlaybackMetadataKeys(queue) {
  const tracks = queue?.tracks;
  if (!Array.isArray(tracks) || !tracks.length) return null;

  const spotifyIds = [];
  const isrcs = [];
  const seenSpotifyIds = new Set();
  const seenIsrcs = new Set();
  let incomplete = false;

  for (let index = 0; index < tracks.length; index += 1) {
    const track = tracks[index];
    if (track?.title && track?.artist && track?.thumbnail_url) continue;
    incomplete = true;

    const spotifyId = text(track?.spotify_id);
    if (spotifyId && !seenSpotifyIds.has(spotifyId)) {
      seenSpotifyIds.add(spotifyId);
      spotifyIds.push(spotifyId);
    }

    const isrc = text(track?.isrc)?.toUpperCase() || null;
    if (isrc && !seenIsrcs.has(isrc)) {
      seenIsrcs.add(isrc);
      isrcs.push(isrc);
    }
  }

  return incomplete ? { spotifyIds, isrcs } : null;
}

async function playbackMetadataRows(env, spotifyIds, isrcs) {
  const localRows = await loadReadModelTrackMetadata({ MINUTE_DB: env?.MINUTE_DB }, spotifyIds, isrcs);
  if (!env?.BUDDIES_DB || env.BUDDIES_DB === env.MINUTE_DB) return localRows;
  const sourceRows = await loadReadModelTrackMetadata({ MINUTE_DB: env.BUDDIES_DB }, spotifyIds, isrcs);
  return localRows.concat(sourceRows);
}

export async function repairPlaybackReadModels(env) {
  const db = env?.MINUTE_DB;
  if (!db) return { repaired: 0, skipped: true, reason: 'db-binding-missing' };
  const current = await db.prepare(`SELECT channel_id,queue_json
    FROM sh_queue_read_model_current WHERE queue_json IS NOT NULL`).all();
  let repaired = 0;
  for (const row of current.results || []) {
    const queue = safeQueue(row.queue_json);
    const keys = incompletePlaybackMetadataKeys(queue);
    if (!keys || (!keys.spotifyIds.length && !keys.isrcs.length)) continue;
    const metadataRows = await playbackMetadataRows(env, keys.spotifyIds, keys.isrcs);
    const hydrated = attachReadModelTrackMetadata(queue, metadataRows);
    if (hydrated === queue) continue;
    await db.prepare(`UPDATE sh_queue_read_model_current SET queue_json=? WHERE channel_id=?`)
      .bind(JSON.stringify(hydrated), row.channel_id).run();
    repaired += 1;
  }
  return { repaired, skipped: false };
}

export async function runBuddiesFactsSync(env, options = {}) {
  const now = integer(options.now) || Date.now();
  const limit = positive(options.limit ?? env?.BUDDIES_SYNC_BATCH_SIZE, DEFAULT_BATCH_SIZE, MAX_BATCH_SIZE);
  const results = await Promise.all(
    SYNC_KEYS.map((syncKey) => syncOneSafely(env, syncKey, now, limit)),
  );
  let playbackRepair;
  try {
    playbackRepair = await repairPlaybackReadModels(env);
  } catch (error) {
    playbackRepair = { repaired: 0, skipped: true, reason: 'repair-error', error: sanitizeFailureDetail(error) };
  }
  return {
    skipped: results.every((result) => result.skipped && result.reason === 'db-binding-missing'),
    failed: results.some((result) => result.reason === 'sync-error') || playbackRepair.reason === 'repair-error',
    error: results.find((result) => result.reason === 'sync-error')?.error || playbackRepair.error || null,
    results,
    playbackRepair,
    rows: results.reduce((sum, result) => sum + Number(result.rows || 0), 0),
  };
}
