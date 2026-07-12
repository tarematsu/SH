import { addDays, finite, jstDate, median, weeksBetween } from './email-recap-utils.js';

export async function loadReferencePoints(env, effectiveAt) {
  const center = jstDate(effectiveAt);
  const from = addDays(center, -3);
  const to = addDays(center, 3);
  const result = await env.OTHER_DB.prepare(`
    SELECT period_key,period_start,period_end,stream_start,stream_end
    FROM sh_daily_summary
    WHERE period_key>=? AND period_key<=?
    ORDER BY period_key ASC
  `).bind(from, to).all();

  const points = [];
  for (const row of result.results || []) {
    const startAt = finite(row.period_start);
    const startCount = finite(row.stream_start);
    const endAt = finite(row.period_end);
    const endCount = finite(row.stream_end);
    if (startAt != null && startCount != null) points.push({ at: startAt, count: startCount, source: 'daily_start' });
    if (endAt != null && endCount != null) points.push({ at: endAt, count: endCount, source: 'daily_end' });
  }
  points.sort((a, b) => a.at - b.at);
  return points;
}

export function assess(points, effectiveAt, streamCount) {
  let previous = null;
  let next = null;
  for (const point of points) {
    if (point.at <= effectiveAt) previous = point;
    if (point.at >= effectiveAt) {
      next = point;
      break;
    }
  }

  let estimated = null;
  if (previous && next && next.at > previous.at) {
    const ratio = (effectiveAt - previous.at) / (next.at - previous.at);
    estimated = Math.round(previous.count + (next.count - previous.count) * ratio);
  } else if (previous) estimated = previous.count;
  else if (next) estimated = next.count;

  let nearest = null;
  if (previous && (!next || Math.abs(effectiveAt - previous.at) <= Math.abs(next.at - effectiveAt))) nearest = previous;
  else nearest = next;

  const difference = estimated == null ? null : streamCount - estimated;
  const relativeDifference = estimated == null || streamCount <= 0
    ? null
    : Math.abs(difference) / streamCount;
  const distanceMinutes = nearest ? Math.abs(nearest.at - effectiveAt) / 60000 : null;

  let status;
  let accepted;
  if (estimated == null || distanceMinutes == null || distanceMinutes > 1440) {
    status = 'unverified_reference_gap';
    accepted = true;
  } else if (Math.abs(difference) <= 1000) {
    status = 'validated_excellent';
    accepted = true;
  } else if (Math.abs(difference) <= 10000) {
    status = 'validated_good';
    accepted = true;
  } else if (Math.abs(difference) <= 50000 && relativeDifference <= 0.001) {
    status = 'validated_plausible';
    accepted = true;
  } else {
    status = 'rejected_mismatch';
    accepted = false;
  }

  return {
    accepted,
    status,
    estimated,
    difference,
    relativeDifference,
    distanceMinutes,
    nearestSource: nearest?.source || null,
    previous,
    next,
  };
}

export const EMAIL_SERIES_CONTEXT_SQL = `WITH existing AS (
  SELECT source_key,week_of,stream_count
  FROM sh_email_stream_snapshots
  WHERE source_key=?
), previous AS (
  SELECT source_key,week_of,stream_count
  FROM sh_email_stream_snapshots
  WHERE week_of<?
  ORDER BY week_of DESC
  LIMIT 9
), following AS (
  SELECT source_key,week_of,stream_count
  FROM sh_email_stream_snapshots
  WHERE week_of>?
  ORDER BY week_of ASC
  LIMIT 1
)
SELECT 0 AS result_kind,source_key,week_of,stream_count FROM existing
UNION ALL
SELECT 1 AS result_kind,source_key,week_of,stream_count FROM previous
UNION ALL
SELECT 2 AS result_kind,source_key,week_of,stream_count FROM following
ORDER BY result_kind ASC,week_of ASC`;

export async function loadEmailSeriesContext(db, sourceKey, weekOf) {
  const result = await db.prepare(EMAIL_SERIES_CONTEXT_SQL).bind(sourceKey, weekOf, weekOf).all();
  let existing = null;
  let next = null;
  const previousRows = [];
  for (const row of result.results || []) {
    const kind = Number(row.result_kind);
    const value = { source_key: row.source_key, week_of: row.week_of, stream_count: row.stream_count };
    if (kind === 0) existing = value;
    else if (kind === 1) previousRows.push(value);
    else if (kind === 2) next = value;
  }
  return { existing, previousRows, next };
}

export async function assessEmailSeries(env, sourceKey, weekOf, streamCount) {
  const { existing, previousRows, next } = await loadEmailSeriesContext(env.DB, sourceKey, weekOf);
  if (existing && Number(existing.stream_count) !== streamCount) {
    return {
      accepted: false,
      status: 'rejected_existing_week_changed',
      reason: `existing=${existing.stream_count}, incoming=${streamCount}`,
    };
  }

  const previous = previousRows.at(-1) || null;

  if (previous && streamCount < Number(previous.stream_count)) {
    return { accepted: false, status: 'rejected_non_monotonic', reason: 'below previous week' };
  }
  if (next && streamCount > Number(next.stream_count)) {
    return { accepted: false, status: 'rejected_non_monotonic', reason: 'above next week' };
  }

  const historicalRates = [];
  for (let index = 1; index < previousRows.length; index += 1) {
    const before = previousRows[index - 1];
    const after = previousRows[index];
    const delta = Number(after.stream_count) - Number(before.stream_count);
    if (delta >= 0) historicalRates.push(delta / weeksBetween(before.week_of, after.week_of));
  }
  const typicalWeeklyGrowth = median(historicalRates);
  let incomingWeeklyGrowth = null;
  if (previous) {
    incomingWeeklyGrowth = (streamCount - Number(previous.stream_count)) / weeksBetween(previous.week_of, weekOf);
  }

  if (
    typicalWeeklyGrowth != null
    && incomingWeeklyGrowth != null
    && incomingWeeklyGrowth > typicalWeeklyGrowth * 3
    && incomingWeeklyGrowth - typicalWeeklyGrowth > 200000
  ) {
    return {
      accepted: false,
      status: 'rejected_growth_anomaly',
      reason: `incoming_per_week=${Math.round(incomingWeeklyGrowth)}, median=${Math.round(typicalWeeklyGrowth)}`,
      typicalWeeklyGrowth,
      incomingWeeklyGrowth,
    };
  }

  return {
    accepted: true,
    status: existing ? 'existing_match' : 'series_plausible',
    previous,
    next,
    typicalWeeklyGrowth,
    incomingWeeklyGrowth,
  };
}
