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

export function observedAtFrom(body, fallback) {
  const observedAt = num(body?.observed_at);
  if (observedAt != null) return observedAt;
  return arguments.length >= 2 ? fallback : Date.now();
}

export function num(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function isRealIsoDate(value) {
  const valueText = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(valueText)) return false;
  const timestamp = Date.parse(`${valueText}T00:00:00Z`);
  return Number.isFinite(timestamp)
    && new Date(timestamp).toISOString().slice(0, 10) === valueText;
}

export function bool(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) return 1;
    if (['false', '0', 'no', 'off', ''].includes(normalized)) return 0;
    return null;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return value === 0 ? 0 : 1;
  }
  return null;
}

export function text(value) {
  return value === undefined || value === null ? null : String(value);
}

export function rawJson(value) {
  return JSON.stringify(value ?? null);
}
