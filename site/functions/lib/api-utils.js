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
  const auth = request.headers.get('authorization') || '';
  return Boolean(expected) && auth === `Bearer ${expected}`;
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

export function isAppleMusicKey(key) {
  return String(key || '').replace(/[_\s-]+/g, '').toLowerCase().includes('applemusic');
}

export function stripAppleMusicFields(value) {
  if (Array.isArray(value)) return value.map(stripAppleMusicFields);
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    if (isAppleMusicKey(key)) continue;
    output[key] = stripAppleMusicFields(child);
  }
  return output;
}

export function rawJson(value) {
  return JSON.stringify(stripAppleMusicFields(value) ?? null);
}
