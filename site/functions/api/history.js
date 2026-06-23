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

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function hostKey(value) {
  return String(value || '').trim().toLowerCase();
}

function finiteNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sortRankingRows(rows, hostOrder = []) {
  const order = new Map(hostOrder.map((host, index) => [hostKey(host), index]));
  return rows.sort((a, b) => {
    const dateOrder = String(b.ranking_date).localeCompare(String(a.ranking_date));
    if (dateOrder !== 0) return dateOrder;
    const aOrder = order.get(hostKey(a.host_name));
    const bOrder = order.get(hostKey(b.host_name));
    if (aOrder != null || bOrder != null) return (aOrder ?? 9999) - (bOrder ?? 9999);
    const aRank = finiteNumber(a.rank);
    const bRank = finiteNumber(b.rank);
    if (aRank != null || bRank != null) {
      return (aRank ?? 9999) - (bRank ?? 9999);
    }
    return String(a.host_name).localeCompare(String(b.host_name));
  });
}

function addRankChanges(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = hostKey(row.host_name);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  for (const hostRows of groups.values()) {
    hostRows.sort((a, b) => String(a.ranking_date).localeCompare(String(b.ranking_date)));
    let previous = null;
    for (const row of hostRows) {
      const currentRank = finiteNumber(row.rank);
      const previousRank = previous ? finiteNumber(previous.rank) : null;
      row.is_out_of_rank = currentRank == null;
      row.previous_rank = previousRank;
      row.previous_out_of_rank = Boolean(previous && previousRank == null);
      row.rank_change = previousRank != null && currentRank != null
        ? previousRank - currentRank
        : null;
      previous = row;
    }
  }
  return rows;
}

function expandWeeklyDates(values) {
  const sorted = [...new Set(values.filter(validDate))].sort();
  if (sorted.length < 2) return sorted;
  const first = Date.parse(`${sorted[0]}T00:00:00Z`);
  const last = Date.parse(`${sorted.at(-1)}T00:00:00Z`);
  if (!Number.isFinite(first) || !Number.isFinite(last)) return sorted;
  const expanded = new Set(sorted);
  for (let ts = first; ts <= last; ts += 7 * 86400000) {
    expanded.add(new Date(ts).toISOString().slice(0, 10));
  }
  return [...expanded].sort();
}

function completeRankingTimeline(actualRows, rankingWeeks, hosts) {
  if (!hosts.length || !rankingWeeks.length) return actualRows;

  const byWeekHost = new Map();
  for (const row of actualRows) {
    byWeekHost.set(`${row.ranking_date}\u0000${hostKey(row.host_name)}`, row);
  }

  const completed = [];
  for (const week of rankingWeeks) {
    for (const host of hosts) {
      const existing = byWeekHost.get(`${week}\u0000${hostKey(host)}`);
      if (existing) {
        completed.push(existing);
      } else {
        completed.push({
          ranking_date: week,
          observed_at: Date.parse(`${week}T00:00:00+09:00`),
          ranking_type: '週間リーダーボード',
          rank: null,
          host_name: host,
          host_alias: host,
          source_sheet: null,
          quality_score: null,
          quality_flags: 'not_listed',
          is_out_of_rank: true,
          synthetic: true,
        });
      }
    }
  }
  return completed;
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

  sql += ' ORDER BY r.ranking_date ASC, r.rank ASC LIMIT ?';
  binds.push(limit);

  try {
    const [rankingResult, weeklyResult, weeksResult] = await Promise.all([
      env.DB.prepare(sql).bind(...binds).all(),
      env.DB.prepare(`SELECT
period_key AS ranking_date,stream_growth,member_growth,listener_avg,
listener_min,listener_max,sample_count,reliable_sample_count,quality_score,quality_flags
FROM sh_weekly_summary
WHERE period_key>=? AND period_key<=?
ORDER BY period_key DESC`).bind(from, to).all(),
      env.DB.prepare(`SELECT DISTINCT ranking_date
FROM sh_channel_rankings
WHERE ranking_date>=? AND ranking_date<=?
ORDER BY ranking_date ASC`).bind(from, to).all(),
    ]);

    const actualRows = rankingResult.results || [];
    const weeklyMetrics = weeklyResult.results || [];
    const rankingWeeks = expandWeeklyDates((weeksResult.results || [])
      .map((row) => row.ranking_date)
      .filter(validDate));

    let selectedHosts;
    if (!hostSearch && scope === 'featured') {
      selectedHosts = FEATURED_HOSTS;
    } else {
      selectedHosts = [...new Set(actualRows.map((row) => row.host_name).filter(Boolean))]
        .sort((a, b) => String(a).localeCompare(String(b)));
    }

    const shouldComplete = scope === 'featured' || Boolean(hostSearch) || selectedHosts.length <= 10;
    const timelineRows = shouldComplete
      ? completeRankingTimeline(actualRows, rankingWeeks, selectedHosts)
      : actualRows;
    const rows = sortRankingRows(addRankChanges(timelineRows), selectedHosts);
    const types = [...new Set(actualRows.map((row) => row.ranking_type).filter(Boolean))].sort();

    return json({
      ok: true,
      mode: 'ranking',
      from,
      to,
      scope,
      featured_hosts: FEATURED_HOSTS,
      rows,
      weekly_metrics: weeklyMetrics,
      ranking_weeks: rankingWeeks,
      ranking_types: types,
      host_count: selectedHosts.length,
      truncated: actualRows.length >= limit,
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
        ranking_weeks: [],
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
