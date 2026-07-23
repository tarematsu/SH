import { sanitizeFailureDetail } from './collector-failure.js';
import { saveMaterializedR2Response } from './pages-response-r2.js';

const RESPONSE_KEY_PREFIX = 'pages-response:v1:';
const KV_CACHE_TTL_SECONDS = 300;

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

function responseFailureDetail(payload) {
  const detail = sanitizeFailureDetail(payload?.error || payload?.message || '');
  return detail ? `: ${detail}` : '';
}

export async function saveMaterializedResponse(
  _db,
  kv,
  modelKey,
  response,
  now,
  cadenceSeconds,
  options = {},
) {
  const key = pagesResponseKey(modelKey);
  if (!key) throw new Error('materialized response key is invalid');
  if (response.headers.get('x-dashboard-facts-stale') === '1') {
    const observedAt = Number(response.headers.get('x-dashboard-facts-observed-at'));
    return {
      skipped: true,
      reason: 'facts-stale',
      facts_latest_observed_at: Number.isFinite(observedAt) && observedAt > 0 ? observedAt : null,
    };
  }
  const body = await response.text();
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error(`${modelKey} did not return JSON`);
  }
  if (!response.ok) {
    throw new Error(`${modelKey} returned HTTP ${response.status}${responseFailureDetail(payload)}`);
  }
  if (payload?.setup_required) throw new Error(`${modelKey} read model is not ready`);

  const headers = persistedHeaders(response);
  let kvSaved = null;
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
      kvSaved = { bytes: body.length, chunks: 1, storage: 'kv' };
    } catch (error) {
      console.error(JSON.stringify({
        event: 'pages_response_kv_publish_failed',
        model_key: modelKey,
        error: String(error?.message || error).slice(0, 500),
      }));
    }
  }

  let r2Saved = null;
  const saveR2 = options.saveR2Response || saveMaterializedR2Response;
  if (typeof options.r2?.put === 'function') {
    try {
      r2Saved = await saveR2(
        options.r2,
        modelKey,
        body,
        response.status,
        headers,
        now,
        cadenceSeconds,
      );
    } catch (error) {
      console.error(JSON.stringify({
        event: 'pages_response_r2_mirror_failed',
        model_key: modelKey,
        error: String(error?.message || error).slice(0, 500),
      }));
    }
  }

  if (kvSaved) return { ...kvSaved, mirror_storage: r2Saved?.storage || null };
  if (r2Saved) return r2Saved;
  throw new Error(`${modelKey} response could not be persisted to KV or R2`);
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
