import { isRealIsoDate } from '../lib/api-utils.js';

const json = (data, status = 200, cache = 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400') =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': cache,
      'vary': 'accept-encoding',
    },
  });

function parseDateStart(value, fallback) {
  const text = isRealIsoDate(value) ? value : fallback;
  return Date.parse(`${text}T00:00:00+09:00`);
}

export async function onRequestGet({ request, env }) {
  if (!env.OTHER_DB) return json({ ok: false, error: 'OTHER_DB binding missing' }, 500, 'no-store');
  try {
    const url = new URL(request.url);
    const fromParam = url.searchParams.get('from');
    const toParam = url.searchParams.get('to');
    if ((fromParam && !isRealIsoDate(fromParam)) || (toParam && !isRealIsoDate(toParam))) {
      return json({ ok: false, error: 'from and to must be valid YYYY-MM-DD dates' }, 400, 'no-store');
    }
    const from = fromParam || '2024-06-01';
    const to = toParam || new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
    if (from > to) return json({ ok: false, error: 'from must not be after to' }, 400, 'no-store');
    const fromTs = parseDateStart(from, '2024-06-01');
    const toTs = parseDateStart(to, to) + 86400000;

    let result;
    try {
      result = await env.OTHER_DB.prepare(`SELECT
        event_name,started_at,ended_at,started_jst,ended_jst,sample_count,
        listener_avg,listener_max,likes_max,distinct_tracks,host_handle
        FROM sh_official_broadcast_summary
        WHERE host_handle='sakurazaka46jp' AND started_at>=? AND started_at<?
        ORDER BY started_at ASC`).bind(fromTs, toTs).all();
    } catch (error) {
      if (!/no such table/i.test(String(error?.message || ''))) throw error;
      return json({ ok: false, error: 'official broadcast summary is not installed', setup_required: true }, 503, 'no-store');
    }
    const rows = result.results || [];

    return json({ ok: true, mode: 'broadcasts', from, to, rows });
  } catch (error) {
    return json({ ok: false, error: error?.message || 'official history error' }, 500, 'no-store');
  }
}
