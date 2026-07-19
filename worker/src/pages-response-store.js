const RESPONSE_KEY_PREFIX = 'pages-response:v1:';
const KV_CACHE_TTL_SECONDS = 300;
const RESPONSE_CHUNK_SIZE = 192_000;
const RESPONSE_MAX_CHUNKS = 80;

const RESPONSE_SCHEMA_SQL = [
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

function normalizedModelKey(value) {
  const key = String(value || '').trim();
  return key && key.length <= 256 ? key : null;
}

export function pagesResponseKey(modelKey) {
  const key = normalizedModelKey(modelKey);
  return key ? `${RESPONSE_KEY_PREFIX}${key}` : null;
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

async function ensureResponseSchema(db) {
  for (const sql of RESPONSE_SCHEMA_SQL) await db.prepare(sql).run();
}

async function saveD1Response(db, modelKey, body, response, headers, now) {
  await ensureResponseSchema(db);
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
    .bind(modelKey, generation, response.status, JSON.stringify(headers), chunks.length, now));
  statements.push(db.prepare(`DELETE FROM sh_pages_response_chunks
    WHERE model_key=? AND generation<>?`).bind(modelKey, generation));
  await db.batch(statements);
  return { bytes: body.length, chunks: chunks.length, storage: 'd1' };
}

export async function saveMaterializedResponse(
  db,
  kv,
  modelKey,
  response,
  now,
  cadenceSeconds,
) {
  const key = pagesResponseKey(modelKey);
  if (!key) throw new Error('materialized response key is invalid');
  const body = await response.text();
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error(`${modelKey} did not return JSON`);
  }
  if (!response.ok) throw new Error(`${modelKey} returned HTTP ${response.status}`);
  if (payload?.setup_required) throw new Error(`${modelKey} read model is not ready`);

  const headers = persistedHeaders(response);
  if (typeof kv?.put === 'function') {
    try {
      await kv.put(key, body, {
        metadata: {
          version: 1,
          status: response.status,
          headers,
          updated_at: now,
          cadence_seconds: cadenceSeconds,
        },
      });
      return { bytes: body.length, chunks: 1, storage: 'kv' };
    } catch (error) {
      console.error(JSON.stringify({
        event: 'pages_response_kv_publish_failed',
        model_key: modelKey,
        error: String(error?.message || error).slice(0, 500),
      }));
    }
  }

  return saveD1Response(db, modelKey, body, response, headers, now);
}

function objectOrNull(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

export async function loadMaterializedResponse(
  kv,
  modelKey,
  now = Date.now(),
  maximumAgeMs = Number.MAX_SAFE_INTEGER,
) {
  const key = pagesResponseKey(modelKey);
  if (!key || typeof kv?.getWithMetadata !== 'function') return null;
  const result = await kv.getWithMetadata(key, {
    type: 'stream',
    cacheTtl: KV_CACHE_TTL_SECONDS,
  });
  if (!result?.value) return null;
  const metadata = objectOrNull(result.metadata);
  if (!metadata || Number(metadata.version) !== 1) return null;
  const updatedAt = Number(metadata.updated_at);
  const maximumAge = Number(maximumAgeMs);
  if (!Number.isFinite(updatedAt) || updatedAt < 0) return null;
  if (Number.isFinite(maximumAge) && maximumAge >= 0 && now - updatedAt > maximumAge) return null;

  const headers = new Headers(objectOrNull(metadata.headers) || {});
  headers.set('x-api-source', 'worker-kv');
  headers.set('x-materialized-at', String(updatedAt));
  const cadenceSeconds = Number(metadata.cadence_seconds);
  if (Number.isFinite(cadenceSeconds) && cadenceSeconds > 0) {
    headers.set('x-materialized-cadence-seconds', String(Math.trunc(cadenceSeconds)));
  }
  return new Response(result.value, {
    status: Number(metadata.status) || 200,
    headers,
  });
}
