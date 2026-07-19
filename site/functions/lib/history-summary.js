import { applySummaryCompleteness, parseRangeStart } from './period-completeness.js';
import {
  applyPeriodBoundaryEvidence,
  loadPeriodBoundaryEvidence,
  rowsRequiringBoundaryEvidence,
} from './period-boundary-evidence.js';

const DAY_MS = 86400000;

export const SUMMARY_TABLES = {
  daily: 'sh_daily_summary',
  weekly: 'sh_weekly_summary',
  monthly: 'sh_monthly_summary',
};

const SUMMARY_COLUMNS = `period_key,period_start,period_end,sample_count,reliable_sample_count,
listener_avg,listener_min,listener_max,stream_start,stream_end,stream_growth,
member_start,member_end,member_growth,likes_max,distinct_tracks,primary_host,
quality_score,quality_flags`;

function finiteNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function todayUtcString(now) {
  return new Date(now).toISOString().slice(0, 10);
}

export function currentSummaryPeriodStart(mode, now = Date.now()) {
  const date = new Date(now);
  date.setUTCHours(0, 0, 0, 0);
  if (mode === 'monthly') {
    date.setUTCDate(1);
  } else if (mode !== 'daily') {
    const daysSinceMonday = (date.getUTCDay() + 6) % 7;
    date.setUTCDate(date.getUTCDate() - daysSinceMonday);
  }
  return date.getTime();
}

export function liveSummaryFallbackStart(mode, now = Date.now()) {
  const current = currentSummaryPeriodStart(mode, now);
  if (mode === 'daily') return current - DAY_MS;
  if (mode === 'monthly') {
    const date = new Date(current);
    date.setUTCMonth(date.getUTCMonth() - 2);
    return date.getTime();
  }
  return current - 14 * DAY_MS;
}

export function boundedLiveSummaryStart(mode, fromTs, lastBaseEnd, now = Date.now()) {
  const afterBase = lastBaseEnd == null ? fromTs : lastBaseEnd + 1;
  return Math.max(fromTs, afterBase, liveSummaryFallbackStart(mode, now));
}

function periodExpression(mode) {
  if (mode === 'daily') return `strftime('%Y-%m-%d', observed_at / 1000, 'unixepoch')`;
  if (mode === 'monthly') return `strftime('%Y-%m', observed_at / 1000, 'unixepoch')`;
  return `date(observed_at / 1000,'unixepoch','-' || ((CAST(strftime('%w', observed_at / 1000, 'unixepoch') AS INTEGER) + 6) % 7) || ' days')`;
}

export function liveSummarySql(mode) {
  const periodKey = periodExpression(mode);
  return `WITH prepared AS (
    SELECT id,observed_at,listener_count,total_member_count,
      validated_stream_count AS stream_value,host_handle,
      ${periodKey} AS period_key
    FROM sh_channel_snapshots WHERE observed_at>=? AND observed_at<?
  ), ranked AS (
    SELECT prepared.*,
      ROW_NUMBER() OVER (
        PARTITION BY period_key
        ORDER BY (stream_value IS NULL) ASC,observed_at ASC,id ASC
      ) AS stream_first_rank,
      ROW_NUMBER() OVER (
        PARTITION BY period_key
        ORDER BY (stream_value IS NULL) ASC,observed_at DESC,id DESC
      ) AS stream_last_rank,
      ROW_NUMBER() OVER (
        PARTITION BY period_key
        ORDER BY (total_member_count IS NULL) ASC,observed_at ASC,id ASC
      ) AS member_first_rank,
      ROW_NUMBER() OVER (
        PARTITION BY period_key
        ORDER BY (total_member_count IS NULL) ASC,observed_at DESC,id DESC
      ) AS member_last_rank
    FROM prepared
  ), aggregated AS (
    SELECT period_key,MIN(observed_at) AS period_start,MAX(observed_at) AS period_end,
      COUNT(*) AS sample_count,COUNT(listener_count) AS reliable_sample_count,
      AVG(listener_count) AS listener_avg,
      MIN(listener_count) AS listener_min,MAX(listener_count) AS listener_max,
      MAX(CASE WHEN stream_first_rank=1 THEN stream_value END) AS stream_start,
      MAX(CASE WHEN stream_last_rank=1 THEN stream_value END) AS stream_end,
      MAX(CASE WHEN member_first_rank=1 THEN total_member_count END) AS member_start,
      MAX(CASE WHEN member_last_rank=1 THEN total_member_count END) AS member_end
    FROM ranked GROUP BY period_key
  ), host_counts AS (
    SELECT period_key,host_handle,COUNT(*) AS host_samples FROM prepared
    WHERE host_handle IS NOT NULL AND host_handle<>'' GROUP BY period_key,host_handle
  ), primary_hosts AS (
    SELECT period_key,host_handle FROM (
      SELECT period_key,host_handle,ROW_NUMBER() OVER (
        PARTITION BY period_key ORDER BY host_samples DESC,host_handle ASC
      ) AS host_rank FROM host_counts
    ) WHERE host_rank=1
  )
  SELECT aggregated.period_key,aggregated.period_start,aggregated.period_end,
    aggregated.sample_count,aggregated.reliable_sample_count,
    aggregated.listener_avg,aggregated.listener_min,aggregated.listener_max,
    aggregated.stream_start,aggregated.stream_end,
    aggregated.member_start,aggregated.member_end,
    primary_hosts.host_handle AS primary_host
  FROM aggregated LEFT JOIN primary_hosts ON primary_hosts.period_key=aggregated.period_key
  ORDER BY aggregated.period_key ASC LIMIT ?`;
}

function normalizeLiveRow(row) {
  const streamStart = finiteNumber(row.stream_start);
  const streamEnd = finiteNumber(row.stream_end);
  const memberStart = finiteNumber(row.member_start);
  const memberEnd = finiteNumber(row.member_end);
  return {
    ...row,
    stream_growth: streamStart != null && streamEnd != null && streamEnd >= streamStart
      ? streamEnd - streamStart
      : null,
    member_growth: memberStart != null && memberEnd != null ? memberEnd - memberStart : null,
    likes_max: null,
    distinct_tracks: null,
    quality_score: 1,
    quality_flags: '["live_collector"]',
    live_collector: true,
  };
}

export function combineSummaryRows(base, live) {
  if (!base) return live;
  if (!live) return base;
  const extrema = (values, mode) => {
    const valid = values.map(finiteNumber).filter((value) => value != null);
    if (!valid.length) return null;
    return mode === 'min' ? Math.min(...valid) : Math.max(...valid);
  };
  const weightedAverage = (a, aCount, b, bCount) => {
    const av = finiteNumber(a);
    const bv = finiteNumber(b);
    if (av == null) return bv;
    if (bv == null) return av;
    return (av * aCount + bv * bCount) / Math.max(1, aCount + bCount);
  };
  const baseCount = finiteNumber(base.reliable_sample_count)
    ?? finiteNumber(base.sample_count)
    ?? 0;
  const liveCount = finiteNumber(live.reliable_sample_count)
    ?? finiteNumber(live.sample_count)
    ?? 0;
  const streamStart = finiteNumber(base.stream_start) ?? finiteNumber(live.stream_start);
  const streamEnd = finiteNumber(live.stream_end) ?? finiteNumber(base.stream_end);
  const memberStart = finiteNumber(base.member_start) ?? finiteNumber(live.member_start);
  const memberEnd = finiteNumber(live.member_end) ?? finiteNumber(base.member_end);
  return {
    ...base,
    ...live,
    period_start: Math.min(finiteNumber(base.period_start) ?? Infinity, finiteNumber(live.period_start) ?? Infinity),
    period_end: Math.max(finiteNumber(base.period_end) ?? 0, finiteNumber(live.period_end) ?? 0),
    sample_count: (finiteNumber(base.sample_count) ?? 0) + (finiteNumber(live.sample_count) ?? 0),
    reliable_sample_count: baseCount + liveCount,
    listener_avg: weightedAverage(base.listener_avg, baseCount, live.listener_avg, liveCount),
    listener_min: extrema([base.listener_min, live.listener_min], 'min'),
    listener_max: extrema([base.listener_max, live.listener_max], 'max'),
    stream_start: streamStart,
    stream_end: streamEnd,
    stream_growth: streamStart != null && streamEnd != null && streamEnd >= streamStart
      ? streamEnd - streamStart
      : null,
    member_start: memberStart,
    member_end: memberEnd,
    member_growth: memberStart != null && memberEnd != null ? memberEnd - memberStart : null,
    primary_host: live.primary_host || base.primary_host,
    quality_flags: '["historical_import","live_collector"]',
    live_collector: true,
  };
}

export async function loadSummaryWithLive(env, mode, from, to, now = Date.now()) {
  const table = SUMMARY_TABLES[mode] || SUMMARY_TABLES.weekly;
  const limit = mode === 'daily' ? 800 : mode === 'weekly' ? 160 : 60;
  const baseResult = await env.OTHER_DB.prepare(
    `SELECT ${SUMMARY_COLUMNS} FROM ${table} WHERE period_key>=? AND period_key<=? ORDER BY period_key ASC LIMIT ?`,
  ).bind(from, to, limit).all();
  const baseRows = baseResult.results || [];
  const fallbackTo = todayUtcString(now);
  const fromTs = parseRangeStart(mode, from, '2024-06-01');
  const toTs = parseRangeStart(mode, to, fallbackTo) + DAY_MS;
  const lastBaseEnd = finiteNumber(baseRows.at(-1)?.period_end);
  const expectedLiveStart = lastBaseEnd == null ? fromTs : Math.max(fromTs, lastBaseEnd + 1);
  const liveStart = boundedLiveSummaryStart(mode, fromTs, lastBaseEnd, now);
  const liveResult = liveStart < toTs
    ? await env.DB.prepare(liveSummarySql(mode)).bind(liveStart, toTs, limit).all()
    : { results: [] };
  const liveRows = (liveResult.results || []).map(normalizeLiveRow);
  const merged = new Map(baseRows.map((row) => [row.period_key, row]));
  liveRows.forEach((row) => merged.set(row.period_key, combineSummaryRows(merged.get(row.period_key), row)));

  const rows = [...merged.values()].slice(-limit);
  const evidenceTargets = rowsRequiringBoundaryEvidence(rows, mode, now);
  const evidence = await loadPeriodBoundaryEvidence(env.DB, evidenceTargets, mode);
  const boundedRows = applyPeriodBoundaryEvidence(rows, evidence);
  const completed = applySummaryCompleteness(boundedRows, mode, now);
  return {
    rows: completed.rows,
    excluded_stream_growth_count: completed.excludedCount,
    boundary_evidence_count: evidence.size,
    live_overlay_count: liveRows.length,
    latest_live_observed_at: liveRows.at(-1)?.period_end || null,
    live_truncated: liveStart > expectedLiveStart,
  };
}
