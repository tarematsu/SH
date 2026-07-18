const MINUTE_MS = 60_000;
const CYCLE_MS = 6 * 60 * MINUTE_MS;
const TRACK_HISTORY_WINDOW_MINUTES = 60;

const CYCLE_SLOT_TASKS = new Map([
  [0, 'dashboard-history'],
  [35, 'history:daily'],
  [50, 'host-history:summary'],
  [70, 'history:weekly'],
  [105, 'history:monthly'],
  [140, 'history:broadcasts'],
  [175, 'minute-facts-current'],
  [210, 'track-likes'],
  [245, 'source:like-ranking'],
  [246, 'like-ranking'],
]);

function validTimestamp(value, fallback = Date.now()) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : fallback;
}

function cyclePosition(timestamp) {
  const cycleStart = Math.floor(timestamp / CYCLE_MS) * CYCLE_MS;
  return {
    cycleStart,
    cycleMinute: Math.floor((timestamp - cycleStart) / MINUTE_MS),
  };
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

export function pagesReadModelTask(now = Date.now()) {
  const timestamp = validTimestamp(now);
  const { cycleStart, cycleMinute } = cyclePosition(timestamp);
  const key = CYCLE_SLOT_TASKS.get(cycleMinute) || null;
  if (!key) return backgroundTask(cycleMinute, cycleStart);
  if (key === 'host-history:summary' && new Date(cycleStart).getUTCHours() !== 0) {
    return backgroundTask(cycleMinute, cycleStart);
  }
  return {
    kind: key === 'source:like-ranking' ? 'source' : 'variant',
    key,
    cycle_minute: cycleMinute,
    cycle_start: cycleStart,
  };
}

export async function runDispatchedPagesReadModelTask(env, now = Date.now(), dependencies = {}) {
  const timestamp = validTimestamp(now);
  const task = pagesReadModelTask(timestamp);
  if (task.kind === 'idle') {
    return {
      skipped: true,
      reason: 'six-hour-cycle-idle',
      generated_at: timestamp,
      task,
      responses: [],
      failed: 0,
    };
  }
  if (task.kind === 'track-history-step') {
    if (!env?.BUDDIES_DB || !env?.MINUTE_DB) {
      throw new Error('Pages read-model task is missing D1 binding(s): BUDDIES_DB, MINUTE_DB');
    }
    const run = dependencies.runTrackHistoryStep
      || (await import('./pages-track-history-cycle.js')).runTrackHistoryCycleStep;
    return run(env, timestamp, dependencies);
  }
  const legacy = await import('./pages-six-hour-read-model.js');
  return legacy.runPagesSixHourTask(env, timestamp, dependencies);
}
