import { attachMinuteFactQueueMetadata } from './collector-payload.js';

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

let schemaReady = new WeakSet();

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

async function hydrateQueueMetadataFromSource(env, readModel) {
  const db = env?.BUDDIES_DB;
  const queue = readModel?.queue?.value;
  if (!db || !queue?.tracks?.length) return readModel;
  const spotifyIds = [...new Set(
    queue.tracks
      .filter((track) => track?.spotify_id
        && (!track.title || !track.artist || !track.thumbnail_url))
      .map((track) => String(track.spotify_id).trim())
      .filter(Boolean),
  )].slice(0, 80);
  if (!spotifyIds.length) return readModel;
  try {
    const placeholders = spotifyIds.map(() => '?').join(',');
    const result = await db.prepare(`SELECT spotify_id,title,artist,thumbnail_url
      FROM sh_track_metadata WHERE spotify_id IN (${placeholders})`)
      .bind(...spotifyIds).all();
    const hydratedQueue = attachMinuteFactQueueMetadata(queue, result.results || []);
    return hydratedQueue === queue
      ? readModel
      : { ...readModel, queue: { ...readModel.queue, value: hydratedQueue } };
  } catch {
    return readModel;
  }
}

export async function ensureMinuteFactReadModelSchema(env) {
  if (!env?.MINUTE_DB) throw new Error('minute fact read model MINUTE_DB binding is missing');
  if (schemaReady.has(env.MINUTE_DB)) return false;
  await env.MINUTE_DB.batch([
    env.MINUTE_DB.prepare(MINUTE_FACT_QUEUE_RECEIPT_SCHEMA_SQL),
    env.MINUTE_DB.prepare(CHANNEL_READ_MODEL_SCHEMA_SQL),
    env.MINUTE_DB.prepare(QUEUE_READ_MODEL_SCHEMA_SQL),
    env.MINUTE_DB.prepare(COLLECTOR_READ_MODEL_SCHEMA_SQL),
  ]);
  schemaReady.add(env.MINUTE_DB);
  return true;
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
  if (!hydratedReadModel || typeof hydratedReadModel !== 'object') throw new Error('minute fact read model payload is missing');
  const channel = hydratedReadModel.channel || {};
  const queue = hydratedReadModel.queue || {};
  const collector = hydratedReadModel.collector || {};
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

export function resetMinuteFactReadModelForTests() {
  schemaReady = new WeakSet();
}
