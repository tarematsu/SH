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

const SUMMARY_COLUMNS = `period_key,period_start,period_end,sample_count,reliable_sample_count,
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

function todayJstString() {
  const shifted = new Date(Date.now() + 9 * 3600000);
  return shifted.toISOString().slice(0, 10);
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

function periodKeyFor(ts, mode) {
  const date = new Date(ts + 9 * 3600000);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  if (mode === 'daily') return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  if (mode === 'monthly') return `${year}-${String(month).padStart(2, '0')}`;
  const monday = new Date(Date.UTC(year, month - 1, day));
  const offset = (monday.getUTCDay() + 6) % 7;
  monday.setUTCDate(monday.getUTCDate() - offset);
  return `${monday.getUTCFullYear()}-${String(monday.getUTCMonth() + 1).padStart(2, '0')}-${String(monday.getUTCDate()).padStart(2, '0')}`;
}

function summarizeLiveSnapshots(rows, mode) {
  const groups = new Map();
  for (const row of rows) {
    const key = periodKeyFor(Number(row.observed_at), mode);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.entries()].map(([periodKey, values]) => {
    values.sort((a, b) => Number(a.observed_at) - Number(b.observed_at));
    const listeners = values.map((row) => finiteNumber(row.listener_count)).filter((value) => value != null);
    const streams = values.map((row) => finiteNumber(row.current_stream_count) ?? finiteNumber(row.total_listens)).filter((value) => value != null);
    const members = values.map((row) => finiteNumber(row.total_member_count)).filter((value) => value != null);
    const hostCounts = new Map();
    values.forEach((row) => {
      if (row.host_handle) hostCounts.set(row.host_handle, (hostCounts.get(row.host_handle) || 0) + 1);
    });
    const primaryHost = [...hostCounts].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    const growth = (list) => list.length >= 2 && list.at(-1) >= list[0] ? list.at(-1) - list[0] : null;
    return {
      period_key: periodKey,
      period_start: Number(values[0].observed_at),
      period_end: Number(values.at(-1).observed_at),
      sample_count: values.length,
      reliable_sample_count: values.length,
      listener_avg: listeners.length ? listeners.reduce((a, b) => a + b, 0) / listeners.length : null,
      listener_min: listeners.length ? Math.min(...listeners) : null,
      listener_max: listeners.length ? Math.max(...listeners) : null,
      stream_start: streams[0] ?? null,
      stream_end: streams.at(-1) ?? null,
      stream_growth: growth(streams),
      member_start: members[0] ?? null,
      member_end: members.at(-1) ?? null,
      member_growth: members.length >= 2 ? members.at(-1) - members[0] : null,
      likes_max: null,
      distinct_tracks: null,
      primary_host: primaryHost,
      quality_score: 1,
      quality_flags: '["live_collector"]',
      live_collector: true,
    };
  });
}

function combineSummaryRows(base, live) {
  if (!base) return live;
  if (!live) return base;
  const extrema = (values, mode) => {
    const valid = values.map(finiteNumber).filter((value) => value != null);
    if (!valid.length) return null;
    return mode === 'min' ? Math.min(...valid) : Math.max(...valid);
  };
  const weightedAverage = (a, aCount, b, bCount) => {
    const av = finiteNumber(a); const bv = finiteNumber(b);
    if (av == null) return bv; if (bv == null) return av;
    return (av * aCount + bv * bCount) / Math.max(1, aCount + bCount);
  };
  const baseCount = finiteNumber(base.reliable_sample_count) || finiteNumber(base.sample_count) || 0;
  const liveCount = finiteNumber(live.reliable_sample_count) || finiteNumber(live.sample_count) || 0;
  const streamStart = finiteNumber(base.stream_start) ?? finiteNumber(live.stream_start);
  const streamEnd = finiteNumber(live.stream_end) ?? finiteNumber(base.stream_end);
  const memberStart = finiteNumber(base.member_start) ?? finiteNumber(live.member_start);
  const memberEnd = finiteNumber(live.member_end) ?? finiteNumber(base.member_end);
  return {
    ...base,
    ...live,
    period_start: Math.min(finiteNumber(base.period_start) ?? Infinity, finiteNumber(live.period_start) ?? Infinity),
    period_end: Math.max(finiteNumber(base.period_end) ?? 0, finiteNumber(live.period_end) ?? 0),
    sample_count: (finiteNumber(base.sample_count) || 0) + (finiteNumber(live.sample_count) || 0),
    reliable_sample_count: baseCount + liveCount,
    listener_avg: weightedAverage(base.listener_avg, baseCount, live.listener_avg, liveCount),
    listener_min: extrema([base.listener_min, live.listener_min], 'min'),
    listener_max: extrema([base.listener_max, live.listener_max], 'max'),
    stream_start: streamStart,
    stream_end: streamEnd,
    stream_growth: streamStart != null && streamEnd != null && streamEnd >= streamStart ? streamEnd - streamStart : null,
    member_start: memberStart,
    member_end: memberEnd,
    member_growth: memberStart != null && memberEnd != null ? memberEnd - memberStart : null,
    primary_host: live.primary_host || base.primary_host,
    quality_flags: '["historical_import","live_collector"]',
    live_collector: true,
  };
}

async function loadSummaryWithLive(env, mode, from, to) {
  const table = SUMMARY_TABLES[mode] || SUMMARY_TABLES.weekly;
  const limit = mode === 'daily' ? 800 : mode === 'weekly' ? 160 : 60;
  const baseResult = await env.DB.prepare(
    `SELECT ${SUMMARY_COLUMNS} FROM ${table} WHERE period_key>=? AND period_key<=? ORDER BY period_key ASC LIMIT ?`,
  ).bind(from, to, limit).all();
  const baseRows = baseResult.results || [];
  const fromTs = parseDateStart(from, '2024-06-01');
  const toTs = addDays(parseDateStart(to, todayJstString()), 1);
  const lastBaseStart = finiteNumber(baseRows.at(-1)?.period_start);
  const liveStart = Math.max(fromTs, lastBaseStart ?? fromTs);
  const liveResult = await env.DB.prepare(`SELECT observed_at,listener_count,online_member_count,total_member_count,total_listens,current_stream_count,host_handle
    FROM sh_channel_snapshots WHERE observed_at>=? AND observed_at<? ORDER BY observed_at ASC LIMIT 100000`).bind(liveStart, toTs).all();
  const liveSnapshots = liveResult.results || [];
  const liveRows = summarizeLiveSnapshots(liveSnapshots, mode);
  const merged = new Map(baseRows.map((row) => [row.period_key, row]));
  liveRows.forEach((row) => merged.set(row.period_key, combineSummaryRows(merged.get(row.period_key), row)));
  const rows = [...merged.values()].sort((a, b) => String(a.period_key).localeCompare(String(b.period_key))).slice(-limit);
  return {
    rows,
    live_overlay_count: liveRows.length,
    latest_live_observed_at: liveSnapshots.at(-1)?.observed_at || null,
    live_truncated: liveSnapshots.length >= 100000,
  };
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
    if (aRank != null || bRank != null) return (aRank ?? 9999) - (bRank ?? 9999);
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
      row.rank_change = previousRank != null && currentRank != null ? previousRank - currentRank : null;
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
  for (let ts = first; ts <= last; ts += 7 * 86400000) expanded.add(new Date(ts).toISOString().slice(0, 10));
  return [...expanded].sort();
}

function completeRankingTimeline(actualRows, rankingWeeks, hosts) {
  if (!hosts.length || !rankingWeeks.length) return actualRows;
  const byWeekHost = new Map();
  for (const row of actualRows) byWeekHost.set(`${row.ranking_date}\u0000${hostKey(row.host_name)}`, row);
  const completed = [];
  for (const week of rankingWeeks) {
    for (const host of hosts) {
      const existing = byWeekHost.get(`${week}\u0000${hostKey(host)}`);
      if (existing) completed.push(existing);
      else completed.push({
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
      loadSummaryWithLive(env, 'weekly', from, to),
      env.DB.prepare(`SELECT DISTINCT ranking_date
FROM sh_channel_rankings
WHERE ranking_date>=? AND ranking_date<=?
ORDER BY ranking_date ASC`).bind(from, to).all(),
    ]);
    const actualRows = rankingResult.results || [];
    const weeklyMetrics = (weeklyResult.rows || []).map((row) => ({ ...row, ranking_date: row.period_key }));
    const rankingWeeks = expandWeeklyDates((weeksResult.results || []).map((row) => row.ranking_date));
    const hostOrder = scope === 'featured' && !hostSearch ? FEATURED_HOSTS : [];
    const hosts = hostSearch
      ? [...new Set(actualRows.map((row) => row.host_name).filter(Boolean))]
      : scope === 'featured'
        ? FEATURED_HOSTS
        : [...new Set(actualRows.map((row) => row.host_name).filter(Boolean))];
    const completedRows = completeRankingTimeline(actualRows, rankingWeeks, hosts);
    addRankChanges(completedRows);
    sortRankingRows(completedRows, hostOrder);
    return json({
      ok: true,
      mode: 'ranking',
      from,
      to,
      scope,
      featured_hosts: FEATURED_HOSTS,
      rows: completedRows,
      weekly_metrics: weeklyMetrics,
      ranking_weeks: rankingWeeks,
      ranking_types: [...new Set(actualRows.map((row) => row.ranking_type).filter(Boolean))],
      host_count: hosts.length,
      truncated: actualRows.length >= limit,
      live_overlay_count: weeklyResult.live_overlay_count,
      latest_live_observed_at: weeklyResult.latest_live_observed_at,
    });
  } catch (error) {
    if (/no such table|no such column/i.test(String(error?.message || ''))) {
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
    const to = url.searchParams.get('to') || todayJstString();
    if (mode === 'ranking') return loadRanking(url, env);
    if (mode === 'broadcasts') {
      const fromTs = parseDateStart(from, '2024-06-01');
      const toTs = addDays(parseDateStart(to, todayJstString()), 1);
      const [result, diagnostic] = await Promise.all([
        env.DB.prepare(`SELECT
          source_note AS event_name,
          MIN(observed_at) AS started_at,
          MAX(observed_at) AS ended_at,
          MIN(observed_jst) AS started_jst,
          MAX(observed_jst) AS ended_jst,
          COUNT(*) AS sample_count,
          ROUND(AVG(listener_count), 1) AS listener_avg,
          MAX(listener_count) AS listener_max,
          MAX(likes) AS likes_max,
          COUNT(DISTINCT CASE WHEN track_title IS NOT NULL AND track_title<>'' THEN track_title END) AS distinct_tracks,
          host_handle
        FROM sh_legacy_snapshots
        WHERE observed_at>=? AND observed_at<? AND host_handle='sakurazaka46jp' AND source_note IS NOT NULL
        GROUP BY source_note,host_handle
        ORDER BY started_at ASC`).bind(fromTs, toTs).all(),
        env.DB.prepare(`SELECT
          COUNT(*) AS imported_rows,
          COUNT(DISTINCT source_note) AS imported_events,
          MIN(observed_jst) AS first_observed_jst,
          MAX(observed_jst) AS last_observed_jst
        FROM sh_legacy_snapshots
        WHERE host_handle='sakurazaka46jp' AND source_note IS NOT NULL`).first(),
      ]);
      const rows = result.results || [];
      const importedRows = Number(diagnostic?.imported_rows || 0);
      return json({
        ok: true,
        mode,
        from,
        to,
        rows,
        setup_required: importedRows === 0,
        diagnostic: {
          imported_rows: importedRows,
          imported_events: Number(diagnostic?.imported_events || 0),
          first_observed_jst: diagnostic?.first_observed_jst || null,
          last_observed_jst: diagnostic?.last_observed_jst || null,
        },
      }, 200, {
        'cache-control': 'public, max-age=30, s-maxage=60',
      });
    }
    if (mode === 'raw') {
      const fromTs = parseDateStart(from, '2024-06-01');
      const requestedToTs = addDays(parseDateStart(to, todayJstString()), 1);
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
    const summary = await loadSummaryWithLive(env, mode, from, to);
    return json({ ok: true, mode, from, to, ...summary }, 200, {
      'cache-control': 'public, max-age=30, s-maxage=60, stale-while-revalidate=120',
    });
  } catch (error) {
    return json({ ok: false, error: error?.message || 'history error' }, 500, {
      'cache-control': 'no-store',
    });
  }
}
