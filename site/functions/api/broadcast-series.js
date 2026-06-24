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

export async function onRequestGet({ request, env }) {
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500);

  try {
    const url = new URL(request.url);
    const from = url.searchParams.get('from') || '2024-06-01';
    const to = url.searchParams.get('to') || todayJstString();
    const fromTs = parseDateStart(from, '2024-06-01');
    const toTs = addDays(parseDateStart(to, todayJstString()), 1);

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
      SELECT event_name, started_at, elapsed_minute, listener_count, source_samples
      FROM minute_points
      ORDER BY started_at ASC, elapsed_minute ASC
      LIMIT 120000
    `).bind(fromTs, toTs, fromTs, toTs).all();

    const rows = result.results || [];
    const grouped = new Map();
    for (const row of rows) {
      const name = String(row.event_name || '公式ステヘ');
      let series = grouped.get(name);
      if (!series) {
        series = {
          event_name: name,
          started_at: Number(row.started_at) || null,
          points: [],
          source_samples: 0,
        };
        grouped.set(name, series);
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
      truncated: rows.length >= 120000,
      x_origin: 'broadcast_start',
      x_unit: 'minute',
    });
  } catch (error) {
    return json({ ok: false, error: error?.message || 'broadcast series error' }, 500);
  }
}
