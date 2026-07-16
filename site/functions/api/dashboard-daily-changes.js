const DAY_MS = 86_400_000;

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'public, max-age=300, s-maxage=900, stale-while-revalidate=3600',
  vary: 'accept-encoding',
};

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: status === 200 ? JSON_HEADERS : { ...JSON_HEADERS, 'cache-control': 'no-store' },
});

// Kept for the Worker-owned legacy read-model refresh. The dashboard endpoint
// now reads completed daily summaries directly from OTHER_DB.
export const UTC_DAILY_METRICS_SQL = `WITH latest_channel AS (
  SELECT channel_id
  FROM sh_minute_facts
  WHERE source_code=1
  ORDER BY minute_at DESC,id DESC
  LIMIT 1
), days(day_at) AS (
  SELECT ? UNION ALL SELECT ? UNION ALL SELECT ?
)
SELECT days.day_at,
  (SELECT f.reported_current_stream_count
   FROM sh_minute_facts AS f
   WHERE f.source_code=1
     AND f.channel_id=(SELECT channel_id FROM latest_channel)
     AND f.minute_at>=days.day_at
     AND f.minute_at<days.day_at+${DAY_MS}
     AND f.reported_current_stream_count IS NOT NULL
   ORDER BY f.minute_at DESC,f.id DESC
   LIMIT 1) AS stream_end,
  (SELECT d.last_total_member_count
   FROM sh_total_member_daily AS d
   WHERE d.channel_id=(SELECT channel_id FROM latest_channel)
     AND d.day_at=days.day_at
     AND d.last_total_member_count IS NOT NULL
   ORDER BY d.last_observed_at DESC,d.host_key DESC
   LIMIT 1) AS member_end
FROM days
ORDER BY days.day_at ASC`;

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

function difference(end, start) {
  const endValue = finite(end);
  const startValue = finite(start);
  return endValue == null || startValue == null ? null : endValue - startValue;
}

export function utcDayStarts(now = Date.now()) {
  const currentStart = Math.floor(now / DAY_MS) * DAY_MS;
  return {
    currentStart,
    yesterdayStart: currentStart - DAY_MS,
    dayBeforeYesterdayStart: currentStart - 2 * DAY_MS,
    threeDaysAgoStart: currentStart - 3 * DAY_MS,
  };
}

export function dailyChangesFromRows(rows, starts) {
  const byDay = new Map((Array.isArray(rows) ? rows : [])
    .map((row) => [finite(row?.day_at), row])
    .filter(([dayAt]) => dayAt != null));
  const yesterday = byDay.get(starts.yesterdayStart);
  const dayBeforeYesterday = byDay.get(starts.dayBeforeYesterdayStart);
  const threeDaysAgo = byDay.get(starts.threeDaysAgoStart);
  return {
    timezone: 'UTC',
    current_day_start: starts.currentStart,
    yesterday: {
      period_key: dayText(starts.yesterdayStart),
      start_at: starts.yesterdayStart,
      end_at: starts.currentStart,
      member_growth: difference(yesterday?.member_end, dayBeforeYesterday?.member_end),
      stream_growth: difference(yesterday?.stream_end, dayBeforeYesterday?.stream_end),
    },
    day_before_yesterday: {
      period_key: dayText(starts.dayBeforeYesterdayStart),
      start_at: starts.dayBeforeYesterdayStart,
      end_at: starts.yesterdayStart,
      member_growth: difference(dayBeforeYesterday?.member_end, threeDaysAgo?.member_end),
      stream_growth: difference(dayBeforeYesterday?.stream_end, threeDaysAgo?.stream_end),
    },
  };
}

export function summaryChangesFromRows(rows, starts) {
  const byPeriod = new Map((Array.isArray(rows) ? rows : [])
    .map((row) => [String(row?.period_key || ''), row])
    .filter(([periodKey]) => periodKey));
  const yesterdayKey = dayText(starts.yesterdayStart);
  const dayBeforeKey = dayText(starts.dayBeforeYesterdayStart);
  const yesterday = byPeriod.get(yesterdayKey);
  const dayBeforeYesterday = byPeriod.get(dayBeforeKey);
  return {
    timezone: 'UTC',
    current_day_start: starts.currentStart,
    source: 'sh_daily_summary',
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

export async function onRequestGet({ env }) {
  if (!env?.OTHER_DB) return json({ ok: false, error: 'OTHER_DB binding missing' }, 500);
  try {
    const starts = utcDayStarts();
    const result = await env.OTHER_DB.prepare(DAILY_SUMMARY_SQL)
      .bind(dayText(starts.dayBeforeYesterdayStart), dayText(starts.yesterdayStart))
      .all();
    return json({ ok: true, ...summaryChangesFromRows(result.results || [], starts) });
  } catch (error) {
    if (/no such table/i.test(String(error?.message || ''))) {
      return json({ ok: true, timezone: 'UTC', source: 'sh_daily_summary', setup_required: true, yesterday: {}, day_before_yesterday: {} });
    }
    return json({ ok: false, error: error?.message || 'dashboard daily changes error' }, 500);
  }
}
