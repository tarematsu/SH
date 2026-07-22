import { runSplitTrackHistoryCycleStep } from './pages-track-history-split-cycle.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const CYCLE_MS = 6 * HOUR_MS;
const TRACK_HISTORY_WINDOW_MINUTES = 355;
const EMPTY_DEPENDENCIES = Object.freeze({});

let sixHourModulePromise;

function cycleSlotKey(cycleMinute) {
  switch (cycleMinute) {
    case 35: return 'history:daily';
    case 50: return 'host-history:summary';
    case 70: return 'history:weekly';
    case 105: return 'history:monthly';
    case 140: return 'history:broadcasts';
    default: return null;
  }
}

function validTimestamp(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? value : Date.now();
  }
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : Date.now();
}

function isBackgroundSlot(key, cycleStart) {
  return !key || (key === 'host-history:summary' && Math.floor(cycleStart / HOUR_MS) % 24 !== 0);
}

function backgroundTask(cycleMinute, cycleStart) {
  if (cycleMinute < TRACK_HISTORY_WINDOW_MINUTES) {
    return {
      kind: 'track-history-step',
      key: 'track-history-stage',
      cycle_minute: cycleMinute,
      cycle_start: cycleStart,
    };
  }
  return {
    kind: 'idle',
    key: 'six-hour-cycle-idle',
    cycle_minute: cycleMinute,
    cycle_start: cycleStart,
  };
}

function pagesReadModelTaskAt(timestamp) {
  const cycleStart = Math.floor(timestamp / CYCLE_MS) * CYCLE_MS;
  const cycleMinute = Math.floor((timestamp - cycleStart) / MINUTE_MS);
  const key = cycleSlotKey(cycleMinute);
  if (isBackgroundSlot(key, cycleStart)) return backgroundTask(cycleMinute, cycleStart);
  return {
    kind: 'variant',
    key,
    cycle_minute: cycleMinute,
    cycle_start: cycleStart,
  };
}

function loadSixHourModule() {
  sixHourModulePromise ||= import('./pages-six-hour-read-model.js');
  return sixHourModulePromise;
}

export function pagesReadModelTask(now = Date.now()) {
  return pagesReadModelTaskAt(validTimestamp(now));
}

export async function runDispatchedPagesReadModelTask(env, now = Date.now(), dependencies = EMPTY_DEPENDENCIES) {
  const timestamp = validTimestamp(now);
  const cycleStart = Math.floor(timestamp / CYCLE_MS) * CYCLE_MS;
  const cycleMinute = Math.floor((timestamp - cycleStart) / MINUTE_MS);
  const key = cycleSlotKey(cycleMinute);
  if (isBackgroundSlot(key, cycleStart)) {
    if (cycleMinute < TRACK_HISTORY_WINDOW_MINUTES) {
      if (!env?.BUDDIES_DB || !env?.MINUTE_DB) {
        throw new Error('Pages read-model task is missing D1 binding(s): BUDDIES_DB, MINUTE_DB');
      }
      const run = dependencies.runTrackHistoryStep || runSplitTrackHistoryCycleStep;
      return run(env, timestamp, dependencies);
    }
    const task = backgroundTask(cycleMinute, cycleStart);
    return {
      skipped: true,
      reason: 'six-hour-cycle-idle',
      generated_at: timestamp,
      task,
      responses: [],
      failed: 0,
    };
  }
  const materializer = await loadSixHourModule();
  return materializer.runPagesSixHourTask(env, timestamp, dependencies);
}
