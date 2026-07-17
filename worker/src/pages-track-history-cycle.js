import { runTrackHistoryHourlyStep } from './pages-track-history-hourly.js';

const MINUTE_MS = 60_000;
export const TRACK_HISTORY_CYCLE_MS = 6 * 60 * 60_000;
export const TRACK_HISTORY_ACTIVE_MINUTES = 60;

export async function runTrackHistoryCycleStep(env, now = Date.now(), dependencies = {}) {
  const timestamp = Number(now);
  const cycleStart = Math.floor(timestamp / TRACK_HISTORY_CYCLE_MS) * TRACK_HISTORY_CYCLE_MS;
  const cycleMinute = Math.floor((timestamp - cycleStart) / MINUTE_MS);
  if (cycleMinute >= TRACK_HISTORY_ACTIVE_MINUTES) {
    return {
      skipped: true,
      reason: 'track-history-cycle-idle',
      generated_at: timestamp,
      task: {
        kind: 'track-history-idle',
        key: 'track-history-hourly-stage',
        cycle_start: cycleStart,
        cycle_minute: cycleMinute,
      },
      responses: [],
      failed: 0,
    };
  }
  return runTrackHistoryHourlyStep(env, timestamp, dependencies);
}
