import { MATERIALIZED_API_VARIANTS } from '../../site/functions/lib/api-contract.js';

const TRACK_HISTORY_MODEL_KEY = 'track-history';
const RESPONSE_CHUNK_SIZE = 192_000;
const RESPONSE_MAX_CHUNKS = 80;

const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS sh_pages_payload_read_model (
    model_key TEXT PRIMARY KEY,
    payload_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sh_pages_track_history_read_model (
    row_key TEXT PRIMARY KEY,
    play_date TEXT NOT NULL,
    first_played_at INTEGER,
    row_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sh_pages_track_history_date
    ON sh_pages_track_history_read_model(play_date,first_played_at,row_key)`,
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

export async function ensurePagesReadModelSchema(db) {
  for (const sql of SCHEMA_SQL) await db.prepare(sql).run();
}

export function materializedVariantDue(variant, now = Date.now()) {
  const cadenceMinutes = Math.max(1, Math.trunc(Number(variant?.cadence_minutes) || 5));
  const absoluteMinute = Math.floor(Number(now) / 60_000);
  return Number.isFinite(absoluteMinute) && absoluteMinute % cadenceMinutes === 0;
}

export function dueFastMaterializedVariants(now = Date.now()) {
  return MATERIALIZED_API_VARIANTS.filter((variant) => (
    variant.key !== TRACK_HISTORY_MODEL_KEY && materializedVariantDue(variant, now)
  ));
}

export async function savePagesPayload(db, key, payload, now) {
  await db.prepare(`INSERT INTO sh_pages_payload_read_model(model_key,payload_json,updated_at)
    VALUES(?,?,?) ON CONFLICT(model_key) DO UPDATE SET
      payload_json=excluded.payload_json,updated_at=excluded.updated_at`)
    .bind(key, JSON.stringify(payload), now).run();
}

export async function readPagesPayload(db, key) {
  return db.prepare(`SELECT payload_json
    FROM sh_pages_payload_read_model
    WHERE model_key=?
    LIMIT 1`).bind(key).first();
}

export function pagesReadModelEnvironment(env = {}) {
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
  let payload = null;
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

async function responseHandler(modelKey) {
  if (modelKey.startsWith('history:')) return (await import('../../site/functions/api/history.js')).onRequestGet;
  if (modelKey === TRACK_HISTORY_MODEL_KEY) return (await import('../../site/functions/api/track-history.js')).onRequestGet;
  if (modelKey === 'host-history:summary') return (await import('../../site/functions/api/host-history.js')).onRequestGet;
  throw new Error(`unsupported materialized API model: ${modelKey}`);
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

export async function materializePagesVariants(variants, targetDb, activeEnv, now, dependencies = {}) {
  const responses = [];
  for (const variant of variants) {
    try {
      const response = await renderVariant(variant, activeEnv, dependencies);
      const saved = await saveResponse(targetDb, variant.key, response, now);
      responses.push({ key: variant.key, ok: true, ...saved });
    } catch (error) {
      responses.push({
        key: variant.key,
        ok: false,
        error: String(error?.message || error).replace(/\s+/g, ' ').trim().slice(0, 500),
      });
    }
  }
  return responses;
}

export function pagesResponseSummary(responses, totalVariants = MATERIALIZED_API_VARIANTS.length) {
  return {
    responses,
    due: responses.length,
    deferred: Math.max(0, totalVariants - responses.length),
    succeeded: responses.filter((item) => item.ok).length,
    failed: responses.filter((item) => !item.ok).length,
  };
}

export function trackHistoryMaterializedVariant() {
  const variant = MATERIALIZED_API_VARIANTS.find(({ key }) => key === TRACK_HISTORY_MODEL_KEY);
  if (!variant) throw new Error(`${TRACK_HISTORY_MODEL_KEY} materialized API variant is missing`);
  return variant;
}
