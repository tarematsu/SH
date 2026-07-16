const HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'public, max-age=300, s-maxage=900, stale-while-revalidate=3600',
};

const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: status >= 400 ? { ...HEADERS, 'cache-control': 'no-store' } : HEADERS,
});

function validDate(value) {
  const text = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const timestamp = Date.parse(`${text}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === text;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

export async function onRequestGet({ request, env }) {
  if (!env?.MINUTE_DB) return json({ ok: false, error: 'MINUTE_DB binding missing' }, 500);
  const url = new URL(request.url);

  try {
    if (url.searchParams.get('latest') === '1') {
      const latest = await env.MINUTE_DB.prepare(`SELECT MAX(play_date) AS play_date
        FROM sh_pages_track_history_read_model`).first();
      return json({ ok: true, latest_date: latest?.play_date || null, timezone: 'UTC' });
    }

    const from = url.searchParams.get('from') || '2024-05-01';
    const to = url.searchParams.get('to') || today();
    if (!validDate(from) || !validDate(to) || from > to) {
      return json({ ok: false, error: 'invalid date range' }, 400);
    }
    const requestedLimit = Number(url.searchParams.get('limit'));
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(Math.max(Math.trunc(requestedLimit), 100), 20_000)
      : 10_000;

    const result = await env.MINUTE_DB.prepare(`SELECT row_json
      FROM sh_pages_track_history_read_model
      WHERE play_date>=? AND play_date<=?
      ORDER BY play_date ASC,first_played_at ASC,row_key ASC
      LIMIT ?`).bind(from, to, limit + 1).all();
    const rawRows = result.results || [];
    const truncated = rawRows.length > limit;
    const rows = rawRows.slice(0, limit).map((row) => JSON.parse(row.row_json));
    const status = await env.MINUTE_DB.prepare(`SELECT payload_json
      FROM sh_pages_payload_read_model
      WHERE model_key='track-history-status'
      LIMIT 1`).first();
    const metadata = status?.payload_json ? JSON.parse(status.payload_json) : {};

    return json({
      ok: true,
      mode: 'tracks',
      from,
      to,
      timezone: 'UTC',
      rows,
      truncated,
      likes_included: url.searchParams.get('likes') === '1',
      source_row_count: metadata.source_row_count || 0,
      excluded_play_count_dates: metadata.excluded_play_count_dates || [],
      excluded_play_count_date_count: (metadata.excluded_play_count_dates || []).length,
      generated_at: metadata.generated_at || null,
      historical_recovery: 'worker_materialized_read_model',
      method: 'precomputed_track_history_read_model',
    });
  } catch (error) {
    if (/no such table/i.test(String(error?.message || ''))) {
      return json({ ok: true, mode: 'tracks', rows: [], setup_required: true, timezone: 'UTC' });
    }
    return json({ ok: false, error: error?.message || 'track history error' }, 500);
  }
}
