const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'public, max-age=300, s-maxage=3600, stale-while-revalidate=7200',
};

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: status === 200 ? JSON_HEADERS : { ...JSON_HEADERS, 'cache-control': 'no-store' },
});

function parseDateStart(value, fallback) {
  const text = /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? value : fallback;
  return Date.parse(`${text}T00:00:00+09:00`);
}

function addDays(timestamp, days) {
  return timestamp + days * 86400000;
}

function todayJstString() {
  const shifted = new Date(Date.now() + 9 * 3600000);
  return shifted.toISOString().slice(0, 10);
}

async function legacyRows(env, fromTs, toTs) {
  const result = await env.DB.prepare(`
    WITH starts AS (
      SELECT source_note AS event_name, MIN(observed_at) AS started_at
      FROM sh_legacy_snapshots
      WHERE observed_at>=? AND observed_at<?
        AND host_handle='sakurazaka46jp'
        AND source_note IS NOT NULL AND source_note<>''
      GROUP BY source_note
    ), minute_points AS (
      SELECT
        'legacy:' || snapshots.source_note AS series_key,
        snapshots.source_note AS event_name,
        starts.started_at,
        CAST((snapshots.observed_at - starts.started_at) / 60000 AS INTEGER) AS elapsed_minute,
        ROUND(AVG(snapshots.listener_count), 1) AS listener_count,
        COUNT(*) AS source_samples
      FROM sh_legacy_snapshots snapshots
      JOIN starts ON starts.event_name = snapshots.source_note
      WHERE snapshots.observed_at>=? AND snapshots.observed_at<?
        AND snapshots.host_handle='sakurazaka46jp'
        AND snapshots.listener_count IS NOT NULL
      GROUP BY snapshots.source_note, starts.started_at, elapsed_minute
    )
    SELECT series_key,event_name,started_at,elapsed_minute,listener_count,source_samples
    FROM minute_points
    ORDER BY started_at ASC, elapsed_minute ASC
    LIMIT 120000
  `).bind(fromTs, toTs, fromTs, toTs).all();
  return result.results || [];
}

async function failSafeRows(env, fromTs, toTs) {
  try {
    const result = await env.DB.prepare(`
      SELECT
        'news:' || announcements.id AS series_key,
        announcements.event_name AS event_name,
        COALESCE(announcements.first_broadcast_at, announcements.scheduled_at) AS started_at,
        CAST((probes.observed_at - COALESCE(announcements.first_broadcast_at, announcements.scheduled_at)) / 60000 AS INTEGER) AS elapsed_minute,
        ROUND(AVG(probes.listener_count), 1) AS listener_count,
        COUNT(*) AS source_samples
      FROM sh_official_news_announcements announcements
      JOIN sh_official_news_station_probes probes ON probes.announcement_id=announcements.id
      WHERE COALESCE(announcements.first_broadcast_at, announcements.scheduled_at)>=?
        AND COALESCE(announcements.first_broadcast_at, announcements.scheduled_at)<?
        AND probes.is_broadcasting=1
        AND probes.listener_count IS NOT NULL
      GROUP BY announcements.id, announcements.event_name, started_at, elapsed_minute
      ORDER BY started_at ASC, elapsed_minute ASC
      LIMIT 120000
    `).bind(fromTs, toTs).all();
    return result.results || [];
  } catch (error) {
    if (/no such table/i.test(String(error?.message || ''))) return [];
    throw error;
  }
}

export async function onRequestGet({ request, env }) {
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500);

  try {
    const url = new URL(request.url);
    const from = url.searchParams.get('from') || '2024-06-01';
    const to = url.searchParams.get('to') || todayJstString();
    const fromTs = parseDateStart(from, '2024-06-01');
    const toTs = addDays(parseDateStart(to, todayJstString()), 1);

    const [legacy, failSafe] = await Promise.all([
      legacyRows(env, fromTs, toTs),
      failSafeRows(env, fromTs, toTs),
    ]);
    const rows = [...legacy, ...failSafe]
      .sort((a, b) => Number(a.started_at) - Number(b.started_at) || Number(a.elapsed_minute) - Number(b.elapsed_minute))
      .slice(0, 120000);

    const grouped = new Map();
    for (const row of rows) {
      const key = String(row.series_key || `${row.event_name}:${row.started_at}`);
      let series = grouped.get(key);
      if (!series) {
        series = {
          event_name: String(row.event_name || '公式ステヘ'),
          started_at: Number(row.started_at) || null,
          points: [],
          source_samples: 0,
          source: key.startsWith('news:') ? 'official_news_fail_safe' : 'historical_import',
        };
        grouped.set(key, series);
      }
      series.points.push([
        Number(row.elapsed_minute) || 0,
        Number(row.listener_count),
      ]);
      series.source_samples += Number(row.source_samples) || 0;
    }

    const series = [...grouped.values()].sort((a, b) => (a.started_at || 0) - (b.started_at || 0));
    return json({
      ok: true,
      from,
      to,
      series,
      event_count: series.length,
      point_count: rows.length,
      fail_safe_event_count: series.filter((item) => item.source === 'official_news_fail_safe').length,
      truncated: legacy.length >= 120000 || failSafe.length >= 120000 || rows.length >= 120000,
      x_origin: 'broadcast_start',
      x_unit: 'minute',
    });
  } catch (error) {
    return json({ ok: false, error: error?.message || 'broadcast series error' }, 500);
  }
}
