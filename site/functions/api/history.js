const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'public, max-age=300, s-maxage=900, stale-while-revalidate=3600',
};

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...headers } });

const SUMMARY_TABLES = {
  daily: 'sh_daily_summary',
  weekly: 'sh_weekly_summary',
  monthly: 'sh_monthly_summary',
};

const SUMMARY_COLUMNS = `period_key,sample_count,reliable_sample_count,
listener_avg,listener_min,listener_max,stream_start,stream_end,stream_growth,
member_start,member_end,member_growth,likes_max,distinct_tracks,primary_host,
quality_score,quality_flags`;

const FEATURED_HOSTS = ['sakuramankai', 'sakurazaka46jp'];

function parseDateStart(value, fallback) {
  const text = /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? value : fallback;
  return Date.parse(`${text}T00:00:00+09:00`);
}

function addDays(ts, days) {
  return ts + days * 86400000;
}

function encodeCursor(row) {
  if (!row) return null;
  return btoa(`${row.observed_at}:${row.id}`);
}

function decodeCursor(value) {
  if (!value) return null;
  try {
    const [ts, id] = atob(value).split(':').map(Number);
    return Number.isFinite(ts) && Number.isFinite(id) ? { ts, id } : null;
  } catch {
    return null;
  }
}

function safeText(value, max = 100) {
  return String(value || '').trim().slice(0, max);
}

function addRankChanges(rows) {
  const previousByHost = new Map();
  const chronological = [...rows].sort((a, b) => {
    const dateOrder = String(a.ranking_date).localeCompare(String(b.ranking_date));
    if (dateOrder !== 0) return dateOrder;
    return String(a.host_name).localeCompare(String(b.host_name));
  });

  for (const row of chronological) {
    const key = String(row.host_name || '').toLowerCase();
    const currentRank = Number(row.rank);
    const previousRank = previousByHost.get(key);
    row.previous_rank = Number.isFinite(previousRank) ? previousRank : null;
    row.rank_change = Number.isFinite(previousRank) && Number.isFinite(currentRank)
      ? previousRank - currentRank
      : null;
    if (Number.isFinite(currentRank)) previousByHost.set(key, currentRank);
  }

  return rows;
}

async function loadRanking(requestUrl, env) {
  const from = requestUrl.searchParams.get('from') || '2024-06-01';
  const to = requestUrl.searchParams.get('to') || new Date().toISOString().slice(0, 10);
  const hostSearch = safeText(requestUrl.searchParams.get('host'));
  const scope = requestUrl.searchParams.get('scope') === 'all' ? 'all' : 'featured';
  const limit = Math.min(Math.max(Number(requestUrl.searchParams.get('limit')) || 5000, 20), 10000);

  let sql = `SELECT
r.ranking_date,r.observed_at,r.ranking_type,r.rank,
r.channel_name AS host_name,r.channel_alias AS host_alias,
r.source_sheet,r.quality_score,r.quality_flags
FROM sh_channel_rankings r
WHERE r.ranking_date>=? AND r.ranking_date<=?`;
  const binds = [from, to];

  if (hostSearch) {
    sql += ' AND (r.channel_name LIKE ? OR r.channel_alias LIKE ?)';
    binds.push(`%${hostSearch}%`, `%${hostSearch}%`);
  } else if (scope === 'featured') {
    sql += ' AND lower(r.channel_name) IN (?,?)';
    binds.push(...FEATURED_HOSTS);
  }

  sql += ' ORDER BY r.ranking_date DESC, r.rank ASC LIMIT ?';
  binds.push(limit);

  try {
    const [rankingResult, weeklyResult] = await Promise.all([
      env.DB.prepare(sql).bind(...binds).all(),
      env.DB.prepare(`SELECT
period_key AS ranking_date,stream_growth,member_growth,listener_avg,
listener_min,listener_max,sample_count,reliable_sample_count,quality_score,quality_flags
FROM sh_weekly_summary
WHERE period_key>=? AND period_key<=?
ORDER BY period_key DESC`).bind(from, to).all(),
    ]);

    const rows = addRankChanges(rankingResult.results || []);
    const weeklyMetrics = weeklyResult.results || [];
    const types = [...new Set(rows.map((row) => row.ranking_type).filter(Boolean))].sort();
    const hosts = [...new Set(rows.map((row) => row.host_name).filter(Boolean))];

    return json({
      ok: true,
      mode: 'ranking',
      from,
      to,
      scope,
      featured_hosts: FEATURED_HOSTS,
      rows,
      weekly_metrics: weeklyMetrics,
      ranking_types: types,
      host_count: hosts.length,
      truncated: rows.length >= limit,
      weekly_metrics_source: 'Buddies channel history',
    }, 200, { 'cache-control': 'public, max-age=300, s-maxage=900' });
  } catch (error) {
    if (/no such table/i.test(error?.message || '')) {
      return json({
        ok: true,
        mode: 'ranking',
        from,
        to,
        scope,
        featured_hosts: FEATURED_HOSTS,
        rows: [],
        weekly_metrics: [],
        ranking_types: [],
        host_count: 0,
        setup_required: true,
      });
    }
    throw error;
  }
}

export async function onRequestGet({ request, env }) {
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500);

  try {
    const url = new URL(request.url);
    const mode = url.searchParams.get('mode') || 'weekly';
    const from = url.searchParams.get('from') || '2024-06-01';
    const to = url.searchParams.get('to') || new Date().toISOString().slice(0, 10);

    if (mode === 'ranking') return loadRanking(url, env);

    if (mode === 'raw') {
      const fromTs = parseDateStart(from, '2024-06-01');
      const requestedToTs = addDays(parseDateStart(to, new Date().toISOString().slice(0, 10)), 1);
      const toTs = Math.min(requestedToTs, addDays(fromTs, 31));
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 200, 20), 500);
      const cursor = decodeCursor(url.searchParams.get('cursor'));

      let sql = `SELECT id,observed_at,observed_jst,listener_count,total_stream_count,
track_title,artist_name,likes,comment_velocity,host_handle,total_member_count,
source_note,quality_score,quality_flags
FROM sh_legacy_snapshots
WHERE observed_at>=? AND observed_at<?`;
      const binds = [fromTs, toTs];

      if (cursor) {
        sql += ' AND (observed_at>? OR (observed_at=? AND id>?))';
        binds.push(cursor.ts, cursor.ts, cursor.id);
      }

      sql += ' ORDER BY observed_at ASC,id ASC LIMIT ?';
      binds.push(limit + 1);

      const result = await env.DB.prepare(sql).bind(...binds).all();
      const allRows = result.results || [];
      const hasMore = allRows.length > limit;
      const rows = hasMore ? allRows.slice(0, limit) : allRows;
      const nextCursor = hasMore ? encodeCursor(rows.at(-1)) : null;

      return json(
        { ok: true, mode, from, to, rows, has_more: hasMore, next_cursor: nextCursor },
        200,
        { 'cache-control': 'private, max-age=60' },
      );
    }

    const table = SUMMARY_TABLES[mode] || SUMMARY_TABLES.weekly;
    const limit = mode === 'daily' ? 800 : mode === 'weekly' ? 160 : 60;
    const result = await env.DB.prepare(
      `SELECT ${SUMMARY_COLUMNS} FROM ${table}
       WHERE period_key>=? AND period_key<=?
       ORDER BY period_key ASC LIMIT ?`,
    ).bind(from, to, limit).all();

    const rows = result.results || [];
    return json({ ok: true, mode, from, to, rows });
  } catch (error) {
    return json({ ok: false, error: error?.message || 'history error' }, 500, {
      'cache-control': 'no-store',
    });
  }
}
