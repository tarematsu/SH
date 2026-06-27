export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
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

export function rawJson(value) {
  return JSON.stringify(value ?? null);
}
