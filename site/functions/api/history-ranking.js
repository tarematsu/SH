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
  for (let timestamp = first; timestamp <= last; timestamp += 7 * 86400000) {
    expanded.add(new Date(timestamp).toISOString().slice(0, 10));
  }
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

export async function loadRankingRowsAndWeeks(db, rankingStatement, weeksStatement) {
  if (typeof db.batch === 'function') return db.batch([rankingStatement, weeksStatement]);
  return Promise.all([rankingStatement.all(), weeksStatement.all()]);
}

export async function onRequestGet({ request, env }) {
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500);
  const url = new URL(request.url);
  const from = url.searchParams.get('from') || '2024-06-01';
  const to = url.searchParams.get('to') || new Date().toISOString().slice(0, 10);
  const hostSearch = safeText(url.searchParams.get('host'));
  const scope = url.searchParams.get('scope') === 'all' ? 'all' : 'featured';
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 5000, 20), 10000);
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
  sql += ' ORDER BY r.ranking_date ASC,r.rank ASC LIMIT ?';
  binds.push(limit);

  try {
    const rankingStatement = env.DB.prepare(sql).bind(...binds);
    const weeksStatement = env.DB.prepare(`SELECT DISTINCT ranking_date
      FROM sh_channel_rankings
      WHERE ranking_date>=? AND ranking_date<=?
      ORDER BY ranking_date ASC`).bind(from, to);
    const [rankingData, weeklyResult] = await Promise.all([
      loadRankingRowsAndWeeks(env.DB, rankingStatement, weeksStatement),
      loadSummaryWithLive(env, 'weekly', from, to),
    ]);
    const [rankingResult, weeksResult] = rankingData;
    const actualRows = rankingResult?.results || [];
    const weeklyMetrics = (weeklyResult.rows || []).map((row) => ({ ...row, ranking_date: row.period_key }));
    const rankingWeeks = expandWeeklyDates((weeksResult?.results || []).map((row) => row.ranking_date));
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
    return json({ ok: false, error: error?.message || 'ranking history error' }, 500);
  }
}
