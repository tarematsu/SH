const MINUTE_MS = 60_000;
const DEFAULT_PERIOD_MINUTES = 60;

function positiveInteger(value, fallback) {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function sampledSuccessDue(
  timestamp,
  periodMinutes = DEFAULT_PERIOD_MINUTES,
  offsetMinutes = 0,
) {
  const minute = Math.floor(Number(timestamp) / MINUTE_MS);
  if (!Number.isFinite(minute)) return false;
  const period = positiveInteger(periodMinutes, DEFAULT_PERIOD_MINUTES);
  const offset = ((Math.trunc(Number(offsetMinutes) || 0) % period) + period) % period;
  return ((minute - offset) % period + period) % period === 0;
}

export function logSampledSuccess(
  payload,
  timestamp = payload?.observed_at,
  periodMinutes = DEFAULT_PERIOD_MINUTES,
  offsetMinutes = 0,
) {
  if (!sampledSuccessDue(timestamp, periodMinutes, offsetMinutes)) return false;
  console.log(JSON.stringify(payload));
  return true;
}
