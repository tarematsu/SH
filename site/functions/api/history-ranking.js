import { loadSummaryWithLive } from '../lib/history-summary.js';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'public, max-age=60, s-maxage=120, stale-while-revalidate=300',
  vary: 'accept-encoding',
};
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
const FEATURED_HOSTS = ['sakuramankai', 'sakurazaka46jp'];

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
    if (aRank != null || bRank != null) return (aRank ?? 9999) - (bRank ?? 9999);
    return String(a.host_name).localeCompare(String(b.host_name));
  });
}

function expandWeeklyDates(values) {
  const unique = new Set();
  for (const value of values || []) {
    if (validDate(value)) unique.add(value);
  }
  const sorted = [...unique].sort();
  if (sorted.length < 2) return sorted;
  const first = Date.parse(`${sorted[0]}T00:00:00Z`);
  const last = Date.parse(`${sorted.at(-1)}T00:00:00Z`);
  if (!Number.isFinite(first) || !Number.isFinite(last)) return sorted;
  for (let timestamp = first; timestamp <= last; timestamp += 7 * 86400000) {
    unique.add(new Date(timestamp).toISOString().slice(0, 10));
  }
  return [...unique].sort();
}

function completeRankingTimeline(actualRows, rankingWeeks, hosts) {
  if (!hosts.length || !rankingWeeks.length) return actualRows;
  const rowsByWeek = new Map();
  for (const row of actualRows) {
    const week = String(row.ranking_date || '');
    let rowsByHost = rowsByWeek.get(week);
    if (!rowsByHost) {
      rowsByHost = new Map();
      rowsByWeek.set(week, rowsByHost);
    }
    rowsByHost.set(hostKey(row.host_name), row);
  }

  const previousByHost = new Map();
  const completed = new Array(rankingWeeks.length * hosts.length);
  let outputIndex = 0;
  for (const week of rankingWeeks) {
    for (const host of hosts) {
      const key = hostKey(host);
      const row = rowsByWeek.get(week)?.get(key) || {
        ranking_date: week,
        observed_at: Date.parse(`${week}T00:00:00+09:00`),
        ranking_type: '週間リーダーボード',
        rank: null,
        host_name: host,
        host_alias: host,
        source_sheet: null,
        quality_score: null,
        quality_flags: 'not_listed',
        synthetic: true,
      };
      const currentRank = finiteNumber(row.rank);
      const previous = previousByHost.get(key);
      row.is_out_of_rank = currentRank == null;
      row.previous_rank = previous?.rank ?? null;
      row.previous_out_of_rank = Boolean(previous && previous.rank == null);
      row.rank_change = previous?.rank != null && currentRank != null ? previous.rank - currentRank : null;
      previousByHost.set(key, { rank: currentRank });
      completed[outputIndex] = row;
      outputIndex += 1;
    }
  }
  return completed;
}

export function rankingRowsAndWeeksSql(hostSearch, scope) {
  let selectedWhere = '';
  if (hostSearch) selectedWhere = ' WHERE (host_name LIKE ? OR host_alias LIKE ?)';
  else if (scope === 'featured') selectedWhere = ' WHERE lower(host_name) IN (?,?)';

  return `WITH ranged AS (
    SELECT r.ranking_date,r.observed_at,r.ranking_type,r.rank,
      r.channel_name AS host_name,r.channel_alias AS host_alias,
      r.source_sheet,r.quality_score,r.quality_flags
    FROM sh_channel_rankings r
    WHERE r.ranking_date>=? AND r.ranking_date<=?
  ), selected AS (
    SELECT * FROM ranged${selectedWhere}
    ORDER BY ranking_date ASC,rank ASC LIMIT ?
  ), weeks AS (
    SELECT ranking_date FROM ranged GROUP BY ranking_date
  )
  SELECT 0 AS result_kind,ranking_date,observed_at,ranking_type,rank,
    host_name,host_alias,source_sheet,quality_score,quality_flags
  FROM selected
  UNION ALL
  SELECT 1 AS result_kind,ranking_date,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL
  FROM weeks
  ORDER BY result_kind ASC,ranking_date ASC,rank ASC`;
}

export async function loadRankingRowsAndWeeks(statement) {
  const result = await statement.all();
  const rows = [];
  const weeks = [];
  const hostNames = [];
  const rankingTypes = [];
  const seenHosts = new Set();
  const seenTypes = new Set();

  for (const source of result?.results || []) {
    if (Number(source?.result_kind) === 1) {
      if (validDate(source.ranking_date)) weeks.push(source.ranking_date);
      continue;
    }
    const row = { ...source };
    delete row.result_kind;
    rows.push(row);
    const host = String(row.host_name || '').trim();
    const hostId = hostKey(host);
    if (host && !seenHosts.has(hostId)) {
      seenHosts.add(hostId);
      hostNames.push(host);
    }
    const rankingType = String(row.ranking_type || '').trim();
    if (rankingType && !seenTypes.has(rankingType)) {
      seenTypes.add(rankingType);
      rankingTypes.push(rankingType);
    }
  }
  return { rows, weeks, hostNames, rankingTypes };
}

export async function onRequestGet({ request, env }) {
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500);
  const url = new URL(request.url);
  const from = url.searchParams.get('from') || '2024-06-01';
  const to = url.searchParams.get('to') || new Date().toISOString().slice(0, 10);
  const hostSearch = safeText(url.searchParams.get('host'));
  const scope = url.searchParams.get('scope') === 'all' ? 'all' : 'featured';
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 5000, 20), 10000);
  const binds = [from, to];
  if (hostSearch) binds.push(`%${hostSearch}%`, `%${hostSearch}%`);
  else if (scope === 'featured') binds.push(...FEATURED_HOSTS);
  binds.push(limit);

  try {
    const rankingStatement = env.DB.prepare(rankingRowsAndWeeksSql(hostSearch, scope)).bind(...binds);
    const [rankingData, weeklyResult] = await Promise.all([
      loadRankingRowsAndWeeks(rankingStatement),
      loadSummaryWithLive(env, 'weekly', from, to),
    ]);
    const actualRows = rankingData.rows;
    const weeklyMetrics = (weeklyResult.rows || []).map((row) => ({ ...row, ranking_date: row.period_key }));
    const rankingWeeks = expandWeeklyDates(rankingData.weeks);
    const hostOrder = scope === 'featured' && !hostSearch ? FEATURED_HOSTS : [];
    const hosts = hostOrder.length ? FEATURED_HOSTS : rankingData.hostNames;
    const completedRows = completeRankingTimeline(actualRows, rankingWeeks, hosts);
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
      ranking_types: rankingData.rankingTypes,
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
    return json({ ok: false, error: error?.message || 'ranking history error' }, 500);
  }
}
