import { loadTrackLikeRows } from '../lib/track-likes.js';
import { isRealIsoDate } from '../lib/api-utils.js';

const HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'public, max-age=300, s-maxage=900, stale-while-revalidate=3600',
};
const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: status >= 400 ? { ...HEADERS, 'cache-control': 'no-store' } : HEADERS,
});
const timestamp = (value) => Date.parse(`${value}T00:00:00Z`);

export async function onRequestGet({ request, env }) {
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500);
  const url = new URL(request.url);
  const fromParam = url.searchParams.get('from');
  const toParam = url.searchParams.get('to');
  if ((fromParam && !isRealIsoDate(fromParam)) || (toParam && !isRealIsoDate(toParam))) {
    return json({ ok: false, error: 'from and to must be valid YYYY-MM-DD dates' }, 400);
  }
  const from = fromParam || '2024-05-01';
  const to = toParam || new Date().toISOString().slice(0, 10);
  const fromTs = timestamp(from);
  const toTs = timestamp(to) + 86400000;
  if (!Number.isFinite(fromTs) || !Number.isFinite(toTs) || toTs <= fromTs) {
    return json({ ok: false, error: 'invalid date range' }, 400);
  }

  try {
    const rows = await loadTrackLikeRows(env.DB, fromTs, toTs);
    return json({ ok: true, from, to, rows, compact: true });
  } catch (error) {
    return json({ ok: false, error: error?.message || 'track likes error' }, 500);
  }
}
