import { runSplitTrackHistoryCycleStep } from './pages-track-history-split-cycle.js';
import { materializeTrackHistoryRangeThroughR2 } from './pages-track-history-r2-shards.js';

const MINUTE_MS = 60_000;
const PAGES_CYCLE_MINUTES = 24 * 60;
const VARIANT_CADENCE_MINUTES = 6 * 60;
const CYCLE_MS = PAGES_CYCLE_MINUTES * MINUTE_MS;
const TRACK_HISTORY_WINDOW_MINUTES = PAGES_CYCLE_MINUTES - 5;
const EMPTY_DEPENDENCIES = Object.freeze({});

let variantModulePromise;

function cycleSlotKey(cycleMinute) {
  const slotMinute = cycleMinute % VARIANT_CADENCE_MINUTES;
  switch (slotMinute) {
    case 35: return 'history:daily';
    case 50: return cycleMinute === 50 ? 'host-history:summary' : null;
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
    key: 'pages-read-model-cycle-idle',
    cycle_minute: cycleMinute,
    cycle_start: cycleStart,
  };
}

function pagesReadModelTaskAt(timestamp) {
  const cycleStart = Math.floor(timestamp / CYCLE_MS) * CYCLE_MS;
  const cycleMinute = Math.floor((timestamp - cycleStart) / MINUTE_MS);
  const key = cycleSlotKey(cycleMinute);
  if (!key) return backgroundTask(cycleMinute, cycleStart);
  return {
    kind: 'variant',
    key,
    cycle_minute: cycleMinute,
    cycle_start: cycleStart,
  };
}

function loadVariantModule() {
  variantModulePromise ||= import('./pages-six-hour-read-model.js');
  return variantModulePromise;
}

export function pagesReadModelTask(now = Date.now()) {
  return pagesReadModelTaskAt(validTimestamp(now));
}

function compactTrackHistoryDependencies(env, dependencies) {
  if (dependencies.refreshDay || !env?.PAGES_RESPONSE_R2) return dependencies;
  return {
    ...dependencies,
    refreshDay(sourceDb, targetDb, range, timestamp, stageOptions) {
      return materializeTrackHistoryRangeThroughR2(
        sourceDb,
        targetDb,
        range,
        timestamp,
        {
          ...stageOptions,
          r2: env.PAGES_RESPONSE_R2,
        },
      );
    },
  };
}

export async function runDispatchedPagesReadModelTask(env, now = Date.now(), dependencies = EMPTY_DEPENDENCIES) {
  const timestamp = validTimestamp(now);
  const cycleStart = Math.floor(timestamp / CYCLE_MS) * CYCLE_MS;
  const cycleMinute = Math.floor((timestamp - cycleStart) / MINUTE_MS);
  const key = cycleSlotKey(cycleMinute);
  if (!key) {
    if (cycleMinute < TRACK_HISTORY_WINDOW_MINUTES) {
      if (!env?.MINUTE_DB) {
        throw new Error('Pages track-history task is missing D1 binding: MINUTE_DB');
      }
      const run = dependencies.runTrackHistoryStep || runSplitTrackHistoryCycleStep;
      const compactEnv = env.BUDDIES_DB === env.MINUTE_DB
        ? env
        : { ...env, BUDDIES_DB: env.MINUTE_DB };
      return run(
        compactEnv,
        timestamp,
        compactTrackHistoryDependencies(compactEnv, dependencies),
      );
    }
    const task = backgroundTask(cycleMinute, cycleStart);
    return {
      skipped: true,
      reason: 'pages-read-model-cycle-idle',
      generated_at: timestamp,
      task,
      responses: [],
      failed: 0,
    };
  }
  const materializer = await loadVariantModule();
  return materializer.runPagesSixHourTask(env, timestamp, dependencies);
}
