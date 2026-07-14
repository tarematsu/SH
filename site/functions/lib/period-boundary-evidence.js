import {
  KNOWN_DAILY_STREAM_GAPS,
  PERIOD_BOUNDARY_TOLERANCE_MS,
  expectedPeriodBounds,
  isTrustedEmailWeekly,
  periodBoundaryToleranceMs,
  withinPeriodBoundaryTolerance,
} from './period-completeness.js';

function finiteNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function periodBoundaryEvidenceSql(_includeLegacy = false, toleranceMs = PERIOD_BOUNDARY_TOLERANCE_MS) {
  return `WITH periods AS (
    SELECT
      json_extract(value,'$.period_key') AS period_key,
      CAST(json_extract(value,'$.period_start') AS INTEGER) AS period_start,
      CAST(json_extract(value,'$.period_end') AS INTEGER) AS period_end
    FROM json_each(?)
  ), boundaries AS (
    SELECT period_key,'start' AS boundary_name,period_start AS target_at FROM periods
    UNION ALL
    SELECT period_key,'end' AS boundary_name,period_end AS target_at FROM periods
  ), candidates AS (
    SELECT boundaries.period_key,boundaries.boundary_name,boundaries.target_at,
      snapshots.observed_at,
      COALESCE(snapshots.current_stream_count,snapshots.total_listens) AS stream_value,
      snapshots.total_member_count AS member_value,0 AS source_priority,snapshots.id AS source_id
    FROM boundaries
    JOIN sh_channel_snapshots snapshots
      ON snapshots.observed_at BETWEEN boundaries.target_at-${toleranceMs}
        AND boundaries.target_at+${toleranceMs}
  ), ranked AS (
    SELECT candidates.*,
      ROW_NUMBER() OVER (
        PARTITION BY period_key,boundary_name
        ORDER BY ABS(observed_at-target_at),source_priority,
          CASE WHEN boundary_name='start' THEN -observed_at ELSE observed_at END,source_id
      ) AS observed_rank,
      ROW_NUMBER() OVER (
        PARTITION BY period_key,boundary_name
        ORDER BY (stream_value IS NULL),ABS(observed_at-target_at),source_priority,
          CASE WHEN boundary_name='start' THEN -observed_at ELSE observed_at END,source_id
      ) AS stream_rank,
      ROW_NUMBER() OVER (
        PARTITION BY period_key,boundary_name
        ORDER BY (member_value IS NULL),ABS(observed_at-target_at),source_priority,
          CASE WHEN boundary_name='start' THEN -observed_at ELSE observed_at END,source_id
      ) AS member_rank
    FROM candidates
  )
  SELECT period_key,
    MAX(CASE WHEN boundary_name='start' AND observed_rank=1 THEN observed_at END) AS boundary_start_at,
    MAX(CASE WHEN boundary_name='end' AND observed_rank=1 THEN observed_at END) AS boundary_end_at,
    MAX(CASE WHEN boundary_name='start' AND stream_rank=1 THEN stream_value END) AS stream_start,
    MAX(CASE WHEN boundary_name='end' AND stream_rank=1 THEN stream_value END) AS stream_end,
    MAX(CASE WHEN boundary_name='start' AND member_rank=1 THEN member_value END) AS member_start,
    MAX(CASE WHEN boundary_name='end' AND member_rank=1 THEN member_value END) AS member_end
  FROM ranked GROUP BY period_key ORDER BY period_key ASC`;
}

export function summaryRowNeedsBoundaryEvidence(row, mode) {
  const periodKey = String(row?.period_key || '');
  const bounds = expectedPeriodBounds(mode, periodKey);
  if (!bounds) return false;
  const toleranceMs = periodBoundaryToleranceMs(mode);
  const start = Object.hasOwn(row || {}, 'boundary_start_at')
    ? row?.boundary_start_at
    : row?.period_start;
  const end = Object.hasOwn(row || {}, 'boundary_end_at')
    ? row?.boundary_end_at
    : row?.period_end;
  if (!withinPeriodBoundaryTolerance(start, bounds.start, toleranceMs)
      || !withinPeriodBoundaryTolerance(end, bounds.end, toleranceMs)) {
    return true;
  }
  const streamReady = finiteNumber(row?.stream_growth) != null
    || (finiteNumber(row?.stream_start) != null && finiteNumber(row?.stream_end) != null);
  const memberReady = finiteNumber(row?.member_growth) != null
    || (finiteNumber(row?.member_start) != null && finiteNumber(row?.member_end) != null);
  return !streamReady || !memberReady;
}

export function rowsRequiringBoundaryEvidence(rows, mode, now = Date.now()) {
  const toleranceMs = periodBoundaryToleranceMs(mode);
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    const periodKey = String(row?.period_key || '');
    const bounds = expectedPeriodBounds(mode, periodKey);
    if (!bounds || now < bounds.end + toleranceMs) return false;
    if (mode === 'daily' && KNOWN_DAILY_STREAM_GAPS.has(periodKey)) return false;
    if (mode === 'weekly' && isTrustedEmailWeekly(row)) return false;
    return summaryRowNeedsBoundaryEvidence(row, mode);
  });
}

function periodPayload(rows, mode) {
  const periods = [];
  const seen = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const periodKey = String(row?.period_key || '');
    if (!periodKey || seen.has(periodKey)) continue;
    const bounds = expectedPeriodBounds(mode, periodKey);
    if (!bounds) continue;
    seen.add(periodKey);
    periods.push({ period_key: periodKey, period_start: bounds.start, period_end: bounds.end });
  }
  return periods;
}

export async function loadPeriodBoundaryEvidence(db, rows, mode) {
  const periods = periodPayload(rows, mode);
  if (!periods.length) return new Map();
  const payload = JSON.stringify(periods);
  const toleranceMs = periodBoundaryToleranceMs(mode);
  let result;
  try {
    result = await db.prepare(periodBoundaryEvidenceSql(false, toleranceMs)).bind(payload).all();
  } catch (error) {
    if (!/no such table|no such column/i.test(String(error?.message || ''))) throw error;
    return new Map();
  }
  return new Map((result.results || []).map((row) => [String(row.period_key), row]));
}

export function applyPeriodBoundaryEvidence(rows, evidence) {
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const periodKey = String(row?.period_key || '');
    if (!evidence?.has(periodKey)) return row;
    const boundary = evidence.get(periodKey) || {};
    const boundaryStart = finiteNumber(boundary.boundary_start_at);
    const boundaryEnd = finiteNumber(boundary.boundary_end_at);
    const streamStart = finiteNumber(boundary.stream_start);
    const streamEnd = finiteNumber(boundary.stream_end);
    const memberStart = finiteNumber(boundary.member_start);
    const memberEnd = finiteNumber(boundary.member_end);
    return {
      ...row,
      period_start: boundaryStart,
      period_end: boundaryEnd,
      boundary_start_at: boundaryStart,
      boundary_end_at: boundaryEnd,
      stream_start: streamStart,
      stream_end: streamEnd,
      stream_growth: streamStart != null && streamEnd != null && streamEnd >= streamStart
        ? streamEnd - streamStart
        : null,
      member_start: memberStart,
      member_end: memberEnd,
      member_growth: memberStart != null && memberEnd != null ? memberEnd - memberStart : null,
    };
  });
}
