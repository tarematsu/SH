import { isRealIsoDate } from './api-utils.js';

const DAY_MS = 86400000;

export const DAILY_BOUNDARY_TOLERANCE_MS = 15 * 60 * 1000;
export const WEEKLY_BOUNDARY_TOLERANCE_MS = 12 * 60 * 60 * 1000;
export const MONTHLY_BOUNDARY_TOLERANCE_MS = 2 * DAY_MS;
export const PERIOD_BOUNDARY_TOLERANCE_MS = DAILY_BOUNDARY_TOLERANCE_MS;
export const KNOWN_DAILY_STREAM_GAPS = new Set(['2026-04-30']);

const EMAIL_WEEKLY_FROM = '2026-01-01';
const EMAIL_WEEKLY_TO_EXCLUSIVE = '2026-07-01';

function finiteNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function validDate(value) {
  return isRealIsoDate(value);
}

function validMonth(value) {
  const text = String(value || '');
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(text);
}

export function periodBoundaryToleranceMs(mode) {
  if (mode === 'weekly') return WEEKLY_BOUNDARY_TOLERANCE_MS;
  if (mode === 'monthly') return MONTHLY_BOUNDARY_TOLERANCE_MS;
  return DAILY_BOUNDARY_TOLERANCE_MS;
}

export function parseQualityFlags(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
  } catch {}
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function appendFlags(value, flags) {
  const merged = new Set(parseQualityFlags(value));
  for (const flag of flags) merged.add(flag);
  return JSON.stringify([...merged]);
}

function nextMonthKey(monthKey) {
  const [year, month] = monthKey.split('-').map(Number);
  const next = new Date(Date.UTC(year, month, 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function expectedPeriodBounds(mode, periodKey) {
  if (mode === 'daily') {
    if (!validDate(periodKey)) return null;
    const start = Date.parse(`${periodKey}T00:00:00Z`);
    return Number.isFinite(start) ? { start, end: start + DAY_MS } : null;
  }
  if (mode === 'weekly') {
    if (!validDate(periodKey)) return null;
    const start = Date.parse(`${periodKey}T00:00:00Z`);
    return Number.isFinite(start) ? { start, end: start + 7 * DAY_MS } : null;
  }
  if (mode === 'monthly') {
    const monthKey = validMonth(periodKey)
      ? periodKey
      : validDate(periodKey) ? String(periodKey).slice(0, 7) : null;
    if (!monthKey) return null;
    const start = Date.parse(`${monthKey}-01T00:00:00Z`);
    const end = Date.parse(`${nextMonthKey(monthKey)}-01T00:00:00Z`);
    return Number.isFinite(start) && Number.isFinite(end) ? { start, end } : null;
  }
  return null;
}

export function parseRangeStart(mode, value, fallback) {
  const text = validDate(value) ? value : fallback;
  if (!validDate(text)) return NaN;
  return Date.parse(`${text}T00:00:00Z`);
}

export function currentPeriodKey(mode, now = Date.now()) {
  const current = new Date(now);
  const year = current.getUTCFullYear();
  const month = current.getUTCMonth() + 1;
  const day = current.getUTCDate();
  if (mode === 'daily') return current.toISOString().slice(0, 10);
  if (mode === 'monthly') return `${year}-${String(month).padStart(2, '0')}`;
  const monday = new Date(Date.UTC(year, month - 1, day));
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  return monday.toISOString().slice(0, 10);
}

export function isTrustedEmailWeekly(row) {
  const periodKey = String(row?.period_key || '');
  return periodKey >= EMAIL_WEEKLY_FROM && periodKey < EMAIL_WEEKLY_TO_EXCLUSIVE;
}

export function withinPeriodBoundaryTolerance(observedAt, boundaryAt, toleranceMs = DAILY_BOUNDARY_TOLERANCE_MS) {
  const observed = finiteNumber(observedAt);
  const boundary = finiteNumber(boundaryAt);
  return observed != null && boundary != null && Math.abs(observed - boundary) <= toleranceMs;
}

export function evaluatePeriodCompleteness({
  mode,
  periodKey,
  firstObservedAt,
  lastObservedAt,
  qualityFlags,
  now = Date.now(),
  toleranceMs,
  knownGap = false,
}) {
  const bounds = expectedPeriodBounds(mode, periodKey);
  if (!bounds) {
    return { complete: false, trusted: false, reasons: ['invalid_period_key'], bounds: null };
  }

  const suppliedTolerance = finiteNumber(toleranceMs);
  const effectiveToleranceMs = suppliedTolerance == null
    ? periodBoundaryToleranceMs(mode)
    : Math.max(0, suppliedTolerance);
  const current = now < bounds.end + effectiveToleranceMs;
  const trusted = mode === 'weekly' && isTrustedEmailWeekly({
    period_key: periodKey,
    quality_flags: qualityFlags,
  });
  if (trusted && !current) return { complete: true, trusted: true, reasons: [], bounds };

  const reasons = [];
  if (current) reasons.push('current_period');
  if (knownGap) reasons.push('known_collection_gap');
  if (!withinPeriodBoundaryTolerance(firstObservedAt, bounds.start, effectiveToleranceMs)) {
    reasons.push('missing_period_start');
  }
  if (!withinPeriodBoundaryTolerance(lastObservedAt, bounds.end, effectiveToleranceMs)) {
    reasons.push('missing_period_end');
  }
  return { complete: reasons.length === 0, trusted: false, reasons, bounds };
}

function qualityFlagsForReasons(reasons) {
  const flags = [];
  if (reasons.includes('current_period')) flags.push('incomplete_current_period');
  if (reasons.includes('known_collection_gap')) flags.push('known_collection_gap');
  if (reasons.includes('missing_period_start')) flags.push('incomplete_period_start');
  if (reasons.includes('missing_period_end')) flags.push('incomplete_period_end');
  if (reasons.includes('invalid_period_key')) flags.push('invalid_period_key');
  return flags;
}

export function applySummaryCompleteness(rows, mode, now = Date.now()) {
  let excludedCount = 0;
  const completedRows = (Array.isArray(rows) ? rows : []).map((row) => {
    const periodKey = String(row?.period_key || '');
    const hasBoundaryStart = Object.hasOwn(row || {}, 'boundary_start_at');
    const hasBoundaryEnd = Object.hasOwn(row || {}, 'boundary_end_at');
    const evaluation = evaluatePeriodCompleteness({
      mode,
      periodKey,
      firstObservedAt: hasBoundaryStart ? row?.boundary_start_at : row?.period_start,
      lastObservedAt: hasBoundaryEnd ? row?.boundary_end_at : row?.period_end,
      qualityFlags: row?.quality_flags,
      now,
      knownGap: mode === 'daily' && KNOWN_DAILY_STREAM_GAPS.has(periodKey),
    });
    if (evaluation.complete) {
      return {
        ...row,
        period_complete: true,
        stream_growth_excluded: false,
        member_growth_excluded: false,
        exclusion_reasons: [],
      };
    }
    excludedCount += 1;
    return {
      ...row,
      stream_growth: null,
      member_growth: null,
      period_complete: false,
      stream_growth_excluded: true,
      member_growth_excluded: true,
      exclusion_reasons: evaluation.reasons,
      quality_flags: appendFlags(row?.quality_flags, qualityFlagsForReasons(evaluation.reasons)),
    };
  });
  return { rows: completedRows, excludedCount };
}

export function applyTrackPeriodCompleteness(rows, coverageRows, now = Date.now()) {
  const coverage = new Map();
  for (const row of Array.isArray(coverageRows) ? coverageRows : []) {
    const key = String(row?.play_date || '');
    if (!key) continue;
    const first = finiteNumber(row?.period_first_observed_at);
    const last = finiteNumber(row?.period_last_observed_at);
    const current = coverage.get(key) || { first: null, last: null };
    if (first != null) current.first = current.first == null ? first : Math.min(current.first, first);
    if (last != null) current.last = current.last == null ? last : Math.max(current.last, last);
    coverage.set(key, current);
  }

  const evaluations = new Map();
  const excludedDates = new Set();
  const completedRows = (Array.isArray(rows) ? rows : []).map((row) => {
    const periodKey = String(row?.play_date || '');
    let evaluation = evaluations.get(periodKey);
    if (!evaluation) {
      const evidence = coverage.get(periodKey) || {};
      evaluation = evaluatePeriodCompleteness({
        mode: 'daily',
        periodKey,
        firstObservedAt: evidence.first,
        lastObservedAt: evidence.last,
        now,
      });
      evaluations.set(periodKey, evaluation);
    }
    if (!evaluation.complete) excludedDates.add(periodKey);
    return {
      ...row,
      period_complete: evaluation.complete,
      play_count_excluded: !evaluation.complete,
      exclusion_reasons: evaluation.reasons,
    };
  });
  return { rows: completedRows, excludedDates: [...excludedDates].sort() };
}
