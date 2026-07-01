import { loadTrackLikeRows } from '../lib/track-likes.js';

const HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'public, max-age=300, s-maxage=900, stale-while-revalidate=3600',
};
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: HEADERS });
const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value || '');
const timestamp = (value) => Date.parse(`${value}T00:00:00Z`);

export async function onRequestGet({ request, env }) {
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500);
  const url = new URL(request.url);
  const from = validDate(url.searchParams.get('from')) ? url.searchParams.get('from') : '2024-05-01';
  const to = validDate(url.searchParams.get('to'))
    ? url.searchParams.get('to')
    : new Date().toISOString().slice(0, 10);
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
