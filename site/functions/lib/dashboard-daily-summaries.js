const DAY_MS = 86_400_000;

export const DAILY_SUMMARY_SQL = `SELECT period_key,stream_growth,member_growth
  FROM sh_daily_summary
  WHERE period_key IN (?,?)
  ORDER BY period_key ASC`;

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function dayText(value) {
  return new Date(value).toISOString().slice(0, 10);
}

export function utcDayStarts(now = Date.now()) {
  const currentStart = Math.floor(now / DAY_MS) * DAY_MS;
  return {
    currentStart,
    yesterdayStart: currentStart - DAY_MS,
    dayBeforeYesterdayStart: currentStart - 2 * DAY_MS,
  };
}

export function dashboardDailySummaries(rows, starts) {
  const byPeriod = new Map((Array.isArray(rows) ? rows : [])
    .map((row) => [String(row?.period_key || ''), row])
    .filter(([periodKey]) => periodKey));
  const yesterdayKey = dayText(starts.yesterdayStart);
  const dayBeforeKey = dayText(starts.dayBeforeYesterdayStart);
  const yesterday = byPeriod.get(yesterdayKey);
  const dayBeforeYesterday = byPeriod.get(dayBeforeKey);
  return {
    timezone: 'UTC',
    source: 'sh_daily_summary',
    current_day_start: starts.currentStart,
    yesterday: {
      period_key: yesterdayKey,
      start_at: starts.yesterdayStart,
      end_at: starts.currentStart,
      member_growth: finite(yesterday?.member_growth),
      stream_growth: finite(yesterday?.stream_growth),
    },
    day_before_yesterday: {
      period_key: dayBeforeKey,
      start_at: starts.dayBeforeYesterdayStart,
      end_at: starts.yesterdayStart,
      member_growth: finite(dayBeforeYesterday?.member_growth),
      stream_growth: finite(dayBeforeYesterday?.stream_growth),
    },
  };
}

export async function loadDashboardDailySummaries(db, now = Date.now()) {
  const starts = utcDayStarts(now);
  if (!db) return { ...dashboardDailySummaries([], starts), setup_required: true };
  try {
    const result = await db.prepare(DAILY_SUMMARY_SQL)
      .bind(dayText(starts.dayBeforeYesterdayStart), dayText(starts.yesterdayStart))
      .all();
    return dashboardDailySummaries(result.results || [], starts);
  } catch (error) {
    if (/no such table/i.test(String(error?.message || error))) {
      return { ...dashboardDailySummaries([], starts), setup_required: true };
    }
    throw error;
  }
}
