const DAY_MS = 86_400_000;
const TRACK_HISTORY_DAYS = 35;
const TRACK_HISTORY_HOURLY_DAYS = 1;
const TRACK_HISTORY_BACKFILL_DAYS = 1;
const TRACK_HISTORY_FULL_RECONCILE_MS = 30 * DAY_MS;
const TRACK_HISTORY_EPOCH = Date.UTC(2024, 4, 1);

function dayText(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function validTimestamp(value) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : null;
}

export function trackHistoryRefreshRanges(now, backfillState = null, statusState = null) {
  const currentDayStart = Math.floor(now / DAY_MS) * DAY_MS;
  const fullRecentFrom = currentDayStart - TRACK_HISTORY_DAYS * DAY_MS;
  const hourlyRecentFrom = currentDayStart - TRACK_HISTORY_HOURLY_DAYS * DAY_MS;
  const toTs = currentDayStart + DAY_MS;
  const previousFullAt = validTimestamp(
    statusState?.full_reconciled_at ?? statusState?.generated_at,
  );
  const fullReconcile = previousFullAt == null
    || previousFullAt + TRACK_HISTORY_FULL_RECONCILE_MS <= currentDayStart;
  const fullRecent = { fromTs: fullRecentFrom, toTs };
  const recent = {
    fromTs: fullReconcile ? fullRecentFrom : hourlyRecentFrom,
    toTs,
  };
  const storedCursor = Number(backfillState?.next_to);
  const backfillTo = Math.min(
    Number.isFinite(storedCursor) ? storedCursor : fullRecentFrom,
    fullRecentFrom,
  );
  const backfill = backfillTo <= TRACK_HISTORY_EPOCH
    ? null
    : {
      fromTs: Math.max(TRACK_HISTORY_EPOCH, backfillTo - TRACK_HISTORY_BACKFILL_DAYS * DAY_MS),
      toTs: backfillTo,
    };
  return {
    recent,
    fullRecent,
    fullReconcile,
    previousFullAt,
    backfill,
  };
}

export function mergeTrackHistoryExcludedDates(previousDates, refreshedDates, range) {
  const fromDay = dayText(range.fromTs);
  const toDay = dayText(range.toTs - DAY_MS);
  const retained = Array.isArray(previousDates)
    ? previousDates.filter((date) => String(date) < fromDay || String(date) > toDay)
    : [];
  const refreshed = Array.isArray(refreshedDates) ? refreshedDates : [];
  return [...new Set([...retained, ...refreshed].map(String).filter(Boolean))].sort();
}

export async function refreshTrackHistoryPagesReadModel(env, now = Date.now(), dependencies = {}) {
  const refresh = dependencies.publishTrackHistory
    || (await import('./pages-read-model-refresh.js')).refreshTrackHistoryPagesReadModel;
  return refresh(env, now, dependencies);
}
