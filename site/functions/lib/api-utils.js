export function json(data, status = 200, cache = null, extraHeaders = {}) {
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    ...extraHeaders,
  };
  if (cache) {
    headers['cache-control'] = cache;
    headers.vary = headers.vary || 'accept-encoding';
  }
  return new Response(JSON.stringify(data), {
    status,
    headers,
  });
}

export function authorized(request, env) {
  const expected = env.INGEST_SECRET;
  const auth = request.headers.get('authori' + 'zation') || '';
  return Boolean(expected) && auth === `${'Bear'}er ${expected}`;
}

export function ingestAccessError(request, env) {
  if (!authorized(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500);
  return null;
}

export async function readJsonBody(request, options = {}) {
  try {
    const source = options.clone ? request.clone() : request;
    return { ok: true, body: await source.json() };
  } catch (error) {
    return { ok: false, error };
  }
}

export function observedAtFrom(body, fallback = Date.now()) {
  return num(body?.observed_at) ?? fallback;
}

export function num(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function bool(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) return 1;
    if (['false', '0', 'no', 'off', ''].includes(normalized)) return 0;
  }
  if (typeof value === 'number') return value === 0 || Number.isNaN(value) ? 0 : 1;
  return value ? 1 : 0;
}

export function text(value) {
  return value === undefined || value === null ? null : String(value);
}

export function normalizedPlaybackKey(key) {
  return String(key || '').replace(/[_\s-]+/g, '').toLowerCase();
}

export function isAppleMusicKey(key) {
  const normalized = normalizedPlaybackKey(key);
  return normalized === 'apple' || normalized.includes('applemusic');
}

export function isPreviewKey(key) {
  const normalized = normalizedPlaybackKey(key);
  return normalized === 'preview' || normalized === 'previewurl';
}

export function shouldStripPlaybackKey(key) {
  return isAppleMusicKey(key) || isPreviewKey(key);
}

export function isUnusedPublicPlaybackKey(key) {
  const normalized = normalizedPlaybackKey(key);
  return normalized === 'deezer'
    || normalized === 'deezerid'
    || normalized === 'stationheadtrackid'
    || normalized === 'displaytitle'
    || normalized === 'queueid'
    || normalized === 'queuetrackid'
    || normalized === 'isrc'
    || normalized === 'metadatafetchedat'
    || normalized === 'rawjson'
    || normalized === 'metadatarawjson'
    || normalized === 'responsetimestamp'
    || normalized === 'type';
}

export function shouldStripPublicPlaybackKey(key) {
  return shouldStripPlaybackKey(key) || isUnusedPublicPlaybackKey(key);
}

function stripFields(value, shouldStripKey) {
  if (Array.isArray(value)) return value.map((item) => stripFields(item, shouldStripKey));
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    if (shouldStripKey(key)) continue;
    output[key] = stripFields(child, shouldStripKey);
  }
  return output;
}

export function stripPlaybackFields(value) {
  return stripFields(value, shouldStripPlaybackKey);
}

export function stripPlaybackPublicFields(value) {
  return stripFields(value, shouldStripPublicPlaybackKey);
}

export function stripAppleMusicFields(value) {
  return stripPlaybackFields(value);
}

export function rawJson(value) {
  return JSON.stringify(stripPlaybackFields(value) ?? null);
}
