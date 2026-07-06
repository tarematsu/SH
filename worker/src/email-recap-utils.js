export const EMAIL_RECAP_PATH = '/ingest/email-recap';
export const EMAIL_RECAP_LEASE_PATH = '/coordination/lease';
export const DEFAULT_EMAIL_RECAP_OFFSET_MINUTES = 57;

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

export function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

export function authorized(request, env) {
  const expected = String(env.EMAIL_RECAP_SECRET || '').trim();
  const supplied = request.headers.get('authorization') || '';
  return Boolean(expected) && supplied === `Bearer ${expected}`;
}

export function jstDate(timestamp) {
  return new Date(timestamp + 9 * 3600000).toISOString().slice(0, 10);
}

export function addDays(dateText, days) {
  const timestamp = Date.parse(`${dateText}T00:00:00+09:00`);
  return jstDate(timestamp + days * 86400000);
}

export function weeksBetween(a, b) {
  const start = Date.parse(`${a}T00:00:00Z`);
  const end = Date.parse(`${b}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 1;
  return Math.max(1, Math.round((end - start) / (7 * 86400000)));
}

export function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
