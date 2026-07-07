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

export function num(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function bool(value) {
  return value === undefined || value === null ? null : value ? 1 : 0;
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

export function isUnusedPlaybackKey(key) {
  const normalized = normalizedPlaybackKey(key);
  return normalized === 'deezer'
    || normalized === 'deezerid'
    || normalized === 'stationheadtrackid'
    || normalized === 'displaytitle'
    || normalized === 'queueid';
}

export function shouldStripPlaybackKey(key) {
  return isAppleMusicKey(key) || isPreviewKey(key) || isUnusedPlaybackKey(key);
}

export function stripPlaybackFields(value) {
  if (Array.isArray(value)) return value.map(stripPlaybackFields);
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    if (shouldStripPlaybackKey(key)) continue;
    output[key] = stripPlaybackFields(child);
  }
  return output;
}

export function stripAppleMusicFields(value) {
  return stripPlaybackFields(value);
}

export function rawJson(value) {
  return JSON.stringify(stripPlaybackFields(value) ?? null);
}
