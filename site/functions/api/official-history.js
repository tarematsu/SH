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
  const text = /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? value : fallback;
  return Date.parse(`${text}T00:00:00+09:00`);
}

export async function onRequestGet({ request, env }) {
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500, 'no-store');
  try {
    const url = new URL(request.url);
    const from = url.searchParams.get('from') || '2024-06-01';
    const to = url.searchParams.get('to') || new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
    const fromTs = parseDateStart(from, '2024-06-01');
    const toTs = parseDateStart(to, to) + 86400000;

    let rows;
    try {
      const result = await env.DB.prepare(`SELECT
        event_name,started_at,ended_at,started_jst,ended_jst,sample_count,
        listener_avg,listener_max,likes_max,distinct_tracks,host_handle
        FROM sh_official_broadcast_summary
        WHERE host_handle='sakurazaka46jp' AND started_at>=? AND started_at<?
        ORDER BY started_at ASC`).bind(fromTs, toTs).all();
      rows = result.results || [];
    } catch (error) {
      if (!/no such table/i.test(String(error?.message || ''))) throw error;
      const result = await env.DB.prepare(`SELECT
        source_note AS event_name,MIN(observed_at) AS started_at,MAX(observed_at) AS ended_at,
        MIN(observed_jst) AS started_jst,MAX(observed_jst) AS ended_jst,COUNT(*) AS sample_count,
        ROUND(AVG(listener_count),1) AS listener_avg,MAX(listener_count) AS listener_max,
        MAX(likes) AS likes_max,
        COUNT(DISTINCT CASE WHEN track_title IS NOT NULL AND track_title<>'' THEN track_title END) AS distinct_tracks,
        host_handle
        FROM sh_legacy_snapshots
        WHERE host_handle='sakurazaka46jp' AND source_note IS NOT NULL
          AND observed_at>=? AND observed_at<?
        GROUP BY host_handle,source_note ORDER BY started_at ASC`).bind(fromTs, toTs).all();
      rows = result.results || [];
    }

    return json({ ok: true, mode: 'broadcasts', from, to, rows });
  } catch (error) {
    return json({ ok: false, error: error?.message || 'official history error' }, 500, 'no-store');
  }
}
