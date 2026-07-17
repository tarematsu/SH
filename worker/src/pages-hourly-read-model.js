import { MATERIALIZED_API_VARIANTS } from '../../site/functions/lib/api-contract.js';
import { loadLikeRanking } from '../../site/functions/api/like-ranking.js';
import { runTrackHistoryHourlyStep } from './pages-track-history-hourly.js';

const HOUR_MS = 60 * 60_000;
const LIKE_RANKING_LIMIT = 500;
const RESPONSE_CHUNK_SIZE = 192_000;
const RESPONSE_MAX_CHUNKS = 80;

const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS sh_pages_payload_read_model (
    model_key TEXT PRIMARY KEY,
    payload_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sh_pages_response_manifest (
    model_key TEXT PRIMARY KEY,
    generation TEXT NOT NULL,
    status INTEGER NOT NULL,
    headers_json TEXT NOT NULL,
    chunk_count INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sh_pages_response_chunks (
    model_key TEXT NOT NULL,
    generation TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    payload_chunk TEXT NOT NULL,
    PRIMARY KEY(model_key,generation,chunk_index)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sh_pages_response_chunks_generation
    ON sh_pages_response_chunks(model_key,generation,chunk_index)`,
];

const HOURLY_SLOT_TASKS = new Map([
  [0, 'dashboard-history'],
  [5, 'history:daily'],
  [10, 'history:weekly'],
  [15, 'history:monthly'],
  [20, 'history:broadcasts'],
  [25, 'minute-facts-current'],
  [30, 'track-likes'],
  [35, 'source:like-ranking'],
  [40, 'like-ranking'],
  [50, 'host-history:summary'],
]);

function validTimestamp(value, fallback = Date.now()) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : fallback;
}

function trackHistoryStep(minute, hour) {
  return { kind: 'track-history-step', key: 'track-history-stage', minute, hour };
}

export function pagesHourlyTask(now = Date.now()) {
  const timestamp = validTimestamp(now);
  const date = new Date(timestamp);
  const minute = date.getUTCMinutes();
  const hour = date.getUTCHours();
  const key = HOURLY_SLOT_TASKS.get(minute) || null;
  if (!key) return trackHistoryStep(minute, hour);
  if (key === 'host-history:summary' && hour !== 0) return trackHistoryStep(minute, hour);
  if (key === 'source:like-ranking') return { kind: 'source', key, minute, hour };
  return { kind: 'variant', key, minute, hour };
}

async function ensureSchema(db) {
  for (const sql of SCHEMA_SQL) await db.prepare(sql).run();
}

async function savePayload(db, key, payload, now) {
  await db.prepare(`INSERT INTO sh_pages_payload_read_model(model_key,payload_json,updated_at)
    VALUES(?,?,?) ON CONFLICT(model_key) DO UPDATE SET
      payload_json=excluded.payload_json,updated_at=excluded.updated_at`)
    .bind(key, JSON.stringify(payload), now).run();
}

async function payloadUpdatedAt(db, key) {
  const row = await db.prepare(`SELECT updated_at
    FROM sh_pages_payload_read_model
    WHERE model_key=?
    LIMIT 1`).bind(key).first();
  const updatedAt = Number(row?.updated_at);
  return Number.isFinite(updatedAt) && updatedAt >= 0 ? updatedAt : null;
}

async function refreshLikeRankingPayload(db, now) {
  const ranking = await loadLikeRanking(db, { limit: LIKE_RANKING_LIMIT });
  const payload = {
    ok: true,
    mode: 'likes',
    generated_at: now,
    limit: LIKE_RANKING_LIMIT,
    filter: 'artist_starts_sakurazaka_or_isrc_starts_jp',
    counter_name: 'like/bite',
    source: 'stationhead-minute.sh_pages_payload_read_model',
    ...ranking,
  };
  await savePayload(db, 'like-ranking', payload, now);
  return { rows: ranking.rows.length };
}

function pagesEnvironment(env = {}) {
  const active = Object.create(env || null);
  Object.defineProperty(active, 'DB', {
    value: env.BUDDIES_DB || env.DB || null,
    enumerable: true,
  });
  return active;
}

function splitResponseBody(body) {
  const chunks = [];
  let offset = 0;
  while (offset < body.length) {
    let end = Math.min(body.length, offset + RESPONSE_CHUNK_SIZE);
    const last = body.charCodeAt(end - 1);
    if (end < body.length && last >= 0xD800 && last <= 0xDBFF) end -= 1;
    chunks.push(body.slice(offset, end));
    offset = end;
  }
  return chunks.length ? chunks : [''];
}

function persistedHeaders(response) {
  const headers = {};
  for (const [key, value] of response.headers.entries()) {
    const normalized = key.toLowerCase();
    if (normalized === 'cache-control' || normalized === 'content-length' || normalized === 'transfer-encoding') continue;
    headers[key] = value;
  }
  if (!headers['content-type']) headers['content-type'] = 'application/json; charset=utf-8';
  return headers;
}

async function saveResponse(db, modelKey, response, now) {
  const body = await response.text();
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error(`${modelKey} did not return JSON`);
  }
  if (!response.ok) throw new Error(`${modelKey} returned HTTP ${response.status}`);
  if (payload?.setup_required) throw new Error(`${modelKey} read model is not ready`);

  const chunks = splitResponseBody(body);
  if (chunks.length > RESPONSE_MAX_CHUNKS) {
    throw new Error(`${modelKey} response exceeded ${RESPONSE_MAX_CHUNKS} chunks`);
  }
  const generation = `${now}:${modelKey}`;
  const statements = chunks.map((chunk, index) => db.prepare(`INSERT INTO sh_pages_response_chunks(
      model_key,generation,chunk_index,payload_chunk
    ) VALUES(?,?,?,?) ON CONFLICT(model_key,generation,chunk_index) DO UPDATE SET
      payload_chunk=excluded.payload_chunk`)
    .bind(modelKey, generation, index, chunk));
  statements.push(db.prepare(`INSERT INTO sh_pages_response_manifest(
      model_key,generation,status,headers_json,chunk_count,updated_at
    ) VALUES(?,?,?,?,?,?) ON CONFLICT(model_key) DO UPDATE SET
      generation=excluded.generation,status=excluded.status,headers_json=excluded.headers_json,
      chunk_count=excluded.chunk_count,updated_at=excluded.updated_at`)
    .bind(
      modelKey,
      generation,
      response.status,
      JSON.stringify(persistedHeaders(response)),
      chunks.length,
      now,
    ));
  statements.push(db.prepare(`DELETE FROM sh_pages_response_chunks
    WHERE model_key=? AND generation<>?`).bind(modelKey, generation));
  await db.batch(statements);
  return { bytes: body.length, chunks: chunks.length };
}

function variantByKey(key) {
  const variant = MATERIALIZED_API_VARIANTS.find((item) => item.key === key);
  if (!variant) throw new Error(`unsupported hourly Pages task: ${key}`);
  return variant;
}

async function responseHandler(modelKey) {
  if (modelKey === 'dashboard-history') return (await import('../../site/functions/api/dashboard-history.js')).onRequestGet;
  if (modelKey === 'track-likes') return (await import('../../site/functions/api/track-likes.js')).onRequestGet;
  if (modelKey === 'like-ranking') return (await import('../../site/functions/api/like-ranking.js')).onRequestGet;
  if (modelKey === 'minute-facts-current') return (await import('../../site/functions/api/minute-facts/current.js')).onRequestGet;
  if (modelKey.startsWith('history:')) return (await import('../../site/functions/api/history.js')).onRequestGet;
  if (modelKey === 'host-history:summary') return (await import('../../site/functions/api/host-history.js')).onRequestGet;
  throw new Error(`unsupported hourly Pages variant: ${modelKey}`);
}

async function renderVariant(variant, env, dependencies = {}) {
  if (dependencies.render) return dependencies.render(variant, env);
  const handler = await responseHandler(variant.key);
  const request = new Request(`https://pages-materializer.invalid${variant.url}`, {
    method: 'GET',
    headers: { accept: 'application/json' },
  });
  return handler({ request, env });
}

async function materializeVariant(variant, targetDb, activeEnv, now, dependencies = {}) {
  try {
    const response = await renderVariant(variant, activeEnv, dependencies);
    const saved = await saveResponse(targetDb, variant.key, response, now);
    return { key: variant.key, ok: true, ...saved };
  } catch (error) {
    return {
      key: variant.key,
      ok: false,
      error: String(error?.message || error).replace(/\s+/g, ' ').trim().slice(0, 500),
    };
  }
}

function requireBindings(env, names) {
  const missing = names.filter((name) => !env?.[name]);
  if (missing.length) throw new Error(`hourly Pages task is missing D1 binding(s): ${missing.join(', ')}`);
}

function taskResponse(task, timestamp, response) {
  return {
    skipped: false,
    generated_at: timestamp,
    task,
    responses: [response],
    due: 1,
    deferred: MATERIALIZED_API_VARIANTS.length - 1,
    succeeded: response.ok ? 1 : 0,
    failed: response.ok ? 0 : 1,
  };
}

export async function runPagesHourlyTask(env, now = Date.now(), dependencies = {}) {
  const timestamp = validTimestamp(now);
  const task = pagesHourlyTask(timestamp);

  if (task.kind === 'track-history-step') {
    requireBindings(env, ['BUDDIES_DB', 'MINUTE_DB']);
    const runStep = dependencies.runTrackHistoryStep || runTrackHistoryHourlyStep;
    return runStep(env, timestamp, dependencies);
  }

  requireBindings(env, ['BUDDIES_DB', 'MINUTE_DB', 'OTHER_DB']);
  await (dependencies.ensureSchema || ensureSchema)(env.MINUTE_DB);

  if (task.kind === 'source') {
    const refresh = dependencies.refreshLikeRanking || refreshLikeRankingPayload;
    const source = await refresh(env.MINUTE_DB, timestamp);
    return { skipped: false, generated_at: timestamp, task, source, responses: [], failed: 0 };
  }

  if (task.key === 'like-ranking') {
    const readUpdatedAt = dependencies.payloadUpdatedAt || payloadUpdatedAt;
    const updatedAt = await readUpdatedAt(env.MINUTE_DB, 'like-ranking');
    const hourStart = Math.floor(timestamp / HOUR_MS) * HOUR_MS;
    if (updatedAt == null || updatedAt < hourStart) {
      return taskResponse(task, timestamp, {
        key: task.key,
        ok: false,
        error: 'like-ranking source was not refreshed in the current hour',
      });
    }
  }

  const variant = variantByKey(task.key);
  const response = await materializeVariant(
    variant,
    env.MINUTE_DB,
    pagesEnvironment(env),
    timestamp,
    dependencies,
  );
  return taskResponse(task, timestamp, response);
}
