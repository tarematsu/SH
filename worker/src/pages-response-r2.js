const R2_RESPONSE_KEY_PREFIX = 'pages-response/v1/';

function normalizedModelKey(value) {
  const key = String(value || '').trim();
  return key && key.length <= 256 ? key : null;
}

export function pagesR2ResponseKey(modelKey) {
  const key = normalizedModelKey(modelKey);
  return key ? `${R2_RESPONSE_KEY_PREFIX}${encodeURIComponent(key)}.json` : null;
}

function objectOrNull(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function freshEnough(updatedAt, now, maximumAgeMs) {
  const maximumAge = Number(maximumAgeMs);
  if (!Number.isFinite(updatedAt) || updatedAt < 0) return false;
  return !(Number.isFinite(maximumAge) && maximumAge >= 0 && now - updatedAt > maximumAge);
}

export async function saveMaterializedR2Response(
  r2,
  modelKey,
  body,
  status,
  headers,
  now,
  cadenceSeconds,
) {
  const key = pagesR2ResponseKey(modelKey);
  if (!key || typeof r2?.put !== 'function') return null;
  await r2.put(key, body, {
    httpMetadata: {
      contentType: headers?.['content-type'] || 'application/json; charset=utf-8',
    },
    customMetadata: {
      version: '1',
      status: String(Number(status) || 200),
      headers_json: JSON.stringify(headers || {}),
      updated_at: String(Number(now) || Date.now()),
      cadence_seconds: String(Math.max(0, Number(cadenceSeconds) || 0)),
    },
  });
  return { bytes: body.length, chunks: 1, storage: 'r2', object_key: key };
}

export async function loadMaterializedR2Response(
  r2,
  modelKey,
  now = Date.now(),
  maximumAgeMs = Number.MAX_SAFE_INTEGER,
) {
  const key = pagesR2ResponseKey(modelKey);
  if (!key || typeof r2?.get !== 'function') return null;
  const object = await r2.get(key);
  if (!object?.body) return null;
  const metadata = objectOrNull(object.customMetadata) || {};
  if (Number(metadata.version) !== 1) return null;
  const updatedAt = Number(metadata.updated_at);
  if (!freshEnough(updatedAt, now, maximumAgeMs)) return null;

  let persistedHeaders = {};
  try {
    persistedHeaders = JSON.parse(metadata.headers_json || '{}');
  } catch {
    persistedHeaders = {};
  }
  const headers = new Headers(objectOrNull(persistedHeaders) || {});
  if (typeof object.writeHttpMetadata === 'function') object.writeHttpMetadata(headers);
  headers.set('x-api-source', 'worker-r2');
  headers.set('x-materialized-at', String(updatedAt));
  const cadenceSeconds = Number(metadata.cadence_seconds);
  if (Number.isFinite(cadenceSeconds) && cadenceSeconds > 0) {
    headers.set('x-materialized-cadence-seconds', String(Math.trunc(cadenceSeconds)));
  }
  return new Response(object.body, {
    status: Number(metadata.status) || 200,
    headers,
  });
}
