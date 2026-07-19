export const MINUTE_FACT_QUEUE_RECEIPT_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS sh_minute_fact_queue_receipts (
  job_id TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL
)`;

export const CHANNEL_READ_MODEL_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS sh_channel_read_model (
  channel_id INTEGER PRIMARY KEY,
  observed_at INTEGER NOT NULL,
  presentation_json TEXT NOT NULL
)`;

export const QUEUE_READ_MODEL_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS sh_queue_read_model_current (
  channel_id INTEGER PRIMARY KEY,
  observed_at INTEGER NOT NULL,
  station_id INTEGER,
  queue_id INTEGER,
  start_time INTEGER,
  is_paused INTEGER,
  queue_json TEXT
)`;

export const COLLECTOR_READ_MODEL_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS sh_collector_read_model (
  collector_id TEXT PRIMARY KEY,
  last_run_at INTEGER,
  last_success_at INTEGER,
  last_error_present INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
)`;

function integer(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function timestamp(value) {
  const numeric = integer(value);
  if (numeric != null) return numeric;
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function booleanCode(value) {
  if (value == null) return null;
  if (value === false || value === 0 || String(value).toLowerCase() === 'false') return 0;
  return 1;
}

function normalizedIsrc(value) {
  return String(value || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

function boundedText(value, maximum) {
  const text = String(value || '').trim();
  return text ? text.slice(0, maximum) : null;
}

function mergeMetadataRow(current, row) {
  if (!current) return { ...row };
  return {
    ...current,
    title: current.title || row.title || null,
    artist: current.artist || row.artist || null,
    album_name: current.album_name || row.album_name || null,
    thumbnail_url: current.thumbnail_url || row.thumbnail_url || null,
  };
}

export function attachReadModelTrackMetadata(queue, rows = []) {
  if (!queue?.tracks?.length || !rows?.length) return queue;

  const byIsrc = new Map();
  const bySpotifyId = new Map();
  for (const row of rows) {
    const isrc = normalizedIsrc(row?.isrc);
    const spotifyId = String(row?.spotify_id || '').trim();
    if (isrc) byIsrc.set(isrc, mergeMetadataRow(byIsrc.get(isrc), row));
    if (spotifyId) bySpotifyId.set(spotifyId, mergeMetadataRow(bySpotifyId.get(spotifyId), row));
  }

  let changed = false;
  const tracks = queue.tracks.map((track) => {
    const isrc = normalizedIsrc(track?.isrc);
    const spotifyId = String(track?.spotify_id || '').trim();
    const preferred = isrc ? byIsrc.get(isrc) : null;
    const fallback = spotifyId ? bySpotifyId.get(spotifyId) : null;
    if (!preferred && !fallback) return track;

    const title = track.title || boundedText(preferred?.title || fallback?.title, 500);
    const artist = track.artist || boundedText(preferred?.artist || fallback?.artist, 500);
    const albumName = track.album_name || boundedText(preferred?.album_name || fallback?.album_name, 500);
    const thumbnailUrl = track.thumbnail_url
      || boundedText(preferred?.thumbnail_url || fallback?.thumbnail_url, 2_048);
    if (title === track.title
      && artist === track.artist
      && albumName === track.album_name
      && thumbnailUrl === track.thumbnail_url) return track;

    changed = true;
    return {
      ...track,
      title,
      artist,
      album_name: albumName,
      thumbnail_url: thumbnailUrl,
    };
  });

  return changed ? { ...queue, tracks } : queue;
}

function queueValueFromJson(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    // A malformed previous read model must never block a fresh update.
  }
  return null;
}

function sameTrackIdentity(left, right) {
  const leftIsrc = normalizedIsrc(left?.isrc);
  const rightIsrc = normalizedIsrc(right?.isrc);
  if (leftIsrc && rightIsrc) return leftIsrc === rightIsrc;
  const leftSpotifyId = String(left?.spotify_id || '').trim();
  const rightSpotifyId = String(right?.spotify_id || '').trim();
  return Boolean(leftSpotifyId && rightSpotifyId && leftSpotifyId === rightSpotifyId);
}

export function preserveReadModelTrackMetadata(queue, previousQueue) {
  if (!queue?.tracks?.length || !previousQueue?.tracks?.length) return queue;
  const previousByPosition = new Map(previousQueue.tracks.map((track, index) => [
    integer(track?.position) ?? index,
    track,
  ]));
  let changed = false;
  const tracks = queue.tracks.map((track, index) => {
    const position = integer(track?.position) ?? index;
    const previous = previousByPosition.get(position);
    if (!previous || !sameTrackIdentity(track, previous)) return track;
    const title = track.title || previous.title || null;
    const artist = track.artist || previous.artist || null;
    const albumName = track.album_name || previous.album_name || null;
    const thumbnailUrl = track.thumbnail_url || previous.thumbnail_url || null;
    if (title === track.title
      && artist === track.artist
      && albumName === track.album_name
      && thumbnailUrl === track.thumbnail_url) return track;
    changed = true;
    return {
      ...track,
      title,
      artist,
      album_name: albumName,
      thumbnail_url: thumbnailUrl,
    };
  });
  return changed ? { ...queue, tracks } : queue;
}

export function queueNeedsPreviousTrackMetadata(queue) {
  return Boolean(queue?.tracks?.some((track) => (
    !track?.title || !track?.artist || !track?.album_name || !track?.thumbnail_url
  )));
}

async function runMetadataQuery(db, sql, bindings) {
  const statement = db.prepare(sql).bind(...bindings);
  if (typeof statement?.all !== 'function') return [];
  const result = await statement.all();
  return result.results || [];
}

function legacyMetadataQuery(spotifyIds, isrcs) {
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
  if (!clauses.length) return null;
  const whereSql = clauses.join(' OR ');
  return {
    sql: `SELECT spotify_id,isrc,title,artist,thumbnail_url,fetched_at
      FROM sh_track_metadata
      WHERE ${whereSql}
      ORDER BY fetched_at DESC`,
    whereSql,
    bindings,
  };
}

async function queryTrackMetadata(db, spotifyIds, isrcs, includeDictionary = false) {
  if (!db || typeof db.prepare !== 'function') return [];
  const legacy = legacyMetadataQuery(spotifyIds, isrcs);
  if (!legacy) return [];
  if (!includeDictionary || !isrcs.length) {
    return runMetadataQuery(db, legacy.sql, legacy.bindings);
  }

  const dictionaryPlaceholders = isrcs.map(() => '?').join(',');
  const dictionarySql = `SELECT spotify_id,isrc,title,artist,thumbnail_url,fetched_at
    FROM (
      SELECT 0 AS source_priority,spotify_id,isrc,title,artist,thumbnail_url,
        metadata_fetched_at AS fetched_at
      FROM sh_track_dictionary
      WHERE isrc IN (${dictionaryPlaceholders})
      UNION ALL
      SELECT 1 AS source_priority,spotify_id,isrc,title,artist,thumbnail_url,fetched_at
      FROM sh_track_metadata
      WHERE ${legacy.whereSql}
    )
    ORDER BY source_priority,fetched_at DESC`;
  try {
    return await runMetadataQuery(
      db,
      dictionarySql,
      [...isrcs, ...legacy.bindings],
    );
  } catch (error) {
    if (!/no such table|no such column/i.test(String(error?.message || ''))) throw error;
    return runMetadataQuery(db, legacy.sql, legacy.bindings);
  }
}

export async function loadReadModelTrackMetadata(env, spotifyIds, isrcs) {
  const primary = env?.MINUTE_DB;
  const fallback = env?.BUDDIES_DB;
  let rows = [];
  try {
    rows = await queryTrackMetadata(primary, spotifyIds, isrcs, true);
  } catch (error) {
    if (!/no such table|no such column/i.test(String(error?.message || ''))) throw error;
  }
  const completeSpotifyIds = new Set(rows.map((row) => String(row?.spotify_id || '').trim()).filter(Boolean));
  const completeIsrcs = new Set(rows.map((row) => normalizedIsrc(row?.isrc)).filter(Boolean));
  const missingSpotifyIds = spotifyIds.filter((value) => !completeSpotifyIds.has(value));
  const missingIsrcs = isrcs.filter((value) => !completeIsrcs.has(value));
  if ((!missingSpotifyIds.length && !missingIsrcs.length) || !fallback || fallback === primary) return rows;
  try {
    const fallbackRows = await queryTrackMetadata(fallback, missingSpotifyIds, missingIsrcs);
    return [...rows, ...fallbackRows];
  } catch (error) {
    if (!/no such table|no such column/i.test(String(error?.message || ''))) throw error;
    return rows;
  }
}

async function hydrateQueueMetadataFromSource(env, readModel) {
  const queue = readModel?.queue?.value;
  if (!queue?.tracks?.length) return readModel;

  const incomplete = queue.tracks.filter((track) => (
    !track?.title || !track?.artist || !track?.thumbnail_url
  ));
  const spotifyIds = [...new Set(
    incomplete.map((track) => String(track?.spotify_id || '').trim()).filter(Boolean),
  )].slice(0, 80);
  const isrcs = [...new Set(
    incomplete.map((track) => normalizedIsrc(track?.isrc)).filter(Boolean),
  )].slice(0, 80);
  if (!spotifyIds.length && !isrcs.length) return readModel;

  try {
    const metadataRows = await loadReadModelTrackMetadata(env, spotifyIds, isrcs);
    const hydratedQueue = attachReadModelTrackMetadata(queue, metadataRows);
    return hydratedQueue === queue
      ? readModel
      : { ...readModel, queue: { ...readModel.queue, value: hydratedQueue } };
  } catch (error) {
    console.error('minute read-model metadata hydration failed', error);
    return readModel;
  }
}

async function preservePreviousQueueMetadata(env, readModel) {
  const queue = readModel?.queue || {};
  const queueValue = queue.value;
  const channelId = integer(readModel?.channel?.channel_id);
  if (!env?.MINUTE_DB || channelId == null || !queueValue?.tracks?.length) return readModel;
  if (!queueNeedsPreviousTrackMetadata(queueValue)) return readModel;
  const statement = env.MINUTE_DB.prepare(`SELECT queue_id,start_time,queue_json
    FROM sh_queue_read_model_current
    WHERE channel_id=?
    LIMIT 1`).bind(channelId);
  if (typeof statement?.first !== 'function') return readModel;
  const previous = await statement.first();
  if (!previous) return readModel;
  if (integer(previous.queue_id) !== integer(queue.queue_id)
    || timestamp(previous.start_time) !== timestamp(queue.start_time)) return readModel;
  const previousQueue = queueValueFromJson(previous.queue_json);
  const preservedQueue = preserveReadModelTrackMetadata(queueValue, previousQueue);
  return preservedQueue === queueValue
    ? readModel
    : { ...readModel, queue: { ...queue, value: preservedQueue } };
}

export async function ensureMinuteFactReadModelSchema(env) {
  if (!env?.MINUTE_DB) throw new Error('minute fact read model MINUTE_DB binding is missing');
  // Owned by database/facts-migrations/004_buddies_queue_read_models.sql.
  return false;
}

export async function hasMinuteFactQueueReceipt(env, jobId) {
  await ensureMinuteFactReadModelSchema(env);
  const row = await env.MINUTE_DB.prepare(
    'SELECT job_id FROM sh_minute_fact_queue_receipts WHERE job_id=? LIMIT 1',
  ).bind(String(jobId)).first();
  return Boolean(row);
}

export async function saveMinuteFactQueueReceipt(env, jobId) {
  await ensureMinuteFactReadModelSchema(env);
  await env.MINUTE_DB.prepare(
    'INSERT OR IGNORE INTO sh_minute_fact_queue_receipts(job_id,received_at) VALUES(?,?)',
  ).bind(String(jobId), Date.now()).run();
}

export async function saveMinuteFactReadModels(env, readModel, _jobId) {
  await ensureMinuteFactReadModelSchema(env);
  const hydratedReadModel = await hydrateQueueMetadataFromSource(env, readModel);
  const stableReadModel = await preservePreviousQueueMetadata(env, hydratedReadModel);
  if (!stableReadModel || typeof stableReadModel !== 'object') throw new Error('minute fact read model payload is missing');
  const channel = stableReadModel.channel || {};
  const queue = stableReadModel.queue || {};
  const collector = stableReadModel.collector || {};
  const channelId = integer(channel.channel_id);
  const observedAt = integer(channel.observed_at);
  if (channelId == null || observedAt == null) throw new Error('channel read model identity is missing');
  const collectorId = String(collector.collector_id || '').trim();
  if (!collectorId) throw new Error('collector read model identity is missing');

  await env.MINUTE_DB.batch([
    env.MINUTE_DB.prepare(`INSERT INTO sh_channel_read_model(channel_id,observed_at,presentation_json)
      VALUES(?,?,?) ON CONFLICT(channel_id) DO UPDATE SET
        observed_at=excluded.observed_at,presentation_json=excluded.presentation_json
      WHERE excluded.observed_at>=sh_channel_read_model.observed_at`)
      .bind(channelId, observedAt, JSON.stringify(channel.presentation || {})),
    env.MINUTE_DB.prepare(`INSERT INTO sh_queue_read_model_current(
        channel_id,observed_at,station_id,queue_id,start_time,is_paused,queue_json
      ) VALUES(?,?,?,?,?,?,?) ON CONFLICT(channel_id) DO UPDATE SET
        observed_at=excluded.observed_at,station_id=excluded.station_id,queue_id=excluded.queue_id,
        start_time=excluded.start_time,is_paused=excluded.is_paused,queue_json=excluded.queue_json
      WHERE excluded.observed_at>=sh_queue_read_model_current.observed_at`)
      .bind(
        channelId,
        observedAt,
        integer(queue.station_id),
        integer(queue.queue_id),
        timestamp(queue.start_time),
        booleanCode(queue.is_paused),
        JSON.stringify(queue.value || null),
      ),
    env.MINUTE_DB.prepare(`INSERT INTO sh_collector_read_model(
        collector_id,last_run_at,last_success_at,last_error_present,updated_at
      ) VALUES(?,?,?,?,?) ON CONFLICT(collector_id) DO UPDATE SET
        last_run_at=excluded.last_run_at,last_success_at=excluded.last_success_at,
        last_error_present=excluded.last_error_present,updated_at=excluded.updated_at
      WHERE excluded.updated_at>=sh_collector_read_model.updated_at`)
      .bind(
        collectorId,
        integer(collector.last_run_at),
        integer(collector.last_success_at),
        Number(Boolean(collector.last_error_present)),
        integer(collector.updated_at) ?? observedAt,
      ),
  ]);
}

export function resetMinuteFactReadModelForTests() {}
