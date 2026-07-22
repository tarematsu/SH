import {
  MATERIALIZED_API_VARIANTS,
  materializedResponseCadenceSeconds,
} from '../../site/functions/lib/api-contract.js';
import { runSplitTrackHistoryCycleStep } from './pages-track-history-split-cycle.js';
import { saveMaterializedResponse } from './pages-response-store.js';

const MINUTE_MS = 60_000;
const VARIANT_CADENCE_MINUTES = 6 * 60;
export const PAGES_READ_MODEL_CYCLE_MINUTES = 24 * 60;
export const PAGES_READ_MODEL_CYCLE_MS = PAGES_READ_MODEL_CYCLE_MINUTES * MINUTE_MS;
export const TRACK_HISTORY_WINDOW_MINUTES = PAGES_READ_MODEL_CYCLE_MINUTES - 5;

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

function validTimestamp(value, fallback = Date.now()) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : fallback;
}

function cyclePosition(timestamp) {
  const cycleStart = Math.floor(timestamp / PAGES_READ_MODEL_CYCLE_MS) * PAGES_READ_MODEL_CYCLE_MS;
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
    key: 'pages-read-model-cycle-idle',
    cycle_minute: cycleMinute,
    cycle_start: cycleStart,
  };
}

export function pagesSixHourTask(now = Date.now()) {
  const timestamp = validTimestamp(now);
  const { cycleStart, cycleMinute } = cyclePosition(timestamp);
  const key = cycleSlotKey(cycleMinute);
  if (!key) return backgroundTask(cycleMinute, cycleStart);
  return {
    kind: 'variant',
    key,
    cycle_minute: cycleMinute,
    cycle_start: cycleStart,
  };
}

function pagesEnvironment(env = {}) {
  const active = Object.create(env || null);
  Object.defineProperty(active, 'DB', {
    value: env.BUDDIES_DB || env.DB || null,
    enumerable: true,
  });
  return active;
}

function variantByKey(key) {
  const variant = MATERIALIZED_API_VARIANTS.find((item) => item.key === key);
  if (!variant) throw new Error(`unsupported Pages task: ${key}`);
  return variant;
}

async function responseHandler(modelKey) {
  if (modelKey.startsWith('history:')) return (await import('../../site/functions/api/history.js')).onRequestGet;
  if (modelKey === 'host-history:summary') return (await import('../../site/functions/api/host-history.js')).onRequestGet;
  throw new Error(`unsupported Pages variant: ${modelKey}`);
}

async function renderVariant(variant, env, dependencies = {}) {
  if (dependencies.render) return dependencies.render(variant, env);
  const handler = await responseHandler(variant.key);
  const request = new Request(`https://pages-materializer.invalid${variant.url}`, {
    method: 'GET',
    headers: { accept: 'application/json' },
  });
  return handler({ request, env });
}

async function materializeVariant(
  variant,
  targetDb,
  responseKv,
  activeEnv,
  now,
  dependencies = {},
) {
  try {
    const response = await renderVariant(variant, activeEnv, dependencies);
    const save = dependencies.saveResponse || saveMaterializedResponse;
    const saved = await save(
      targetDb,
      responseKv,
      variant.key,
      response,
      now,
      materializedResponseCadenceSeconds(variant.key),
    );
    return { key: variant.key, ok: true, ...saved };
  } catch (error) {
    return {
      key: variant.key,
      ok: false,
      error: String(error?.message || error).replace(/\s+/g, ' ').trim().slice(0, 500),
    };
  }
}

function requireBindings(env, names) {
  const missing = names.filter((name) => !env?.[name]);
  if (missing.length) throw new Error(`Pages read-model task is missing D1 binding(s): ${missing.join(', ')}`);
}

function taskResponse(task, timestamp, response) {
  return {
    skipped: false,
    generated_at: timestamp,
    task,
    responses: [response],
    due: 1,
    deferred: MATERIALIZED_API_VARIANTS.length - 1,
    succeeded: response.ok ? 1 : 0,
    failed: response.ok ? 0 : 1,
  };
}

export async function runPagesSixHourTask(env, now = Date.now(), dependencies = {}) {
  const timestamp = validTimestamp(now);
  const task = pagesSixHourTask(timestamp);

  if (task.kind === 'idle') {
    return {
      skipped: true,
      reason: 'pages-read-model-cycle-idle',
      generated_at: timestamp,
      task,
      responses: [],
      failed: 0,
    };
  }

  if (task.kind === 'track-history-step') {
    requireBindings(env, ['BUDDIES_DB', 'MINUTE_DB']);
    const runStep = dependencies.runTrackHistoryStep || runSplitTrackHistoryCycleStep;
    return runStep(env, timestamp, dependencies);
  }

  requireBindings(env, ['BUDDIES_DB', 'MINUTE_DB', 'OTHER_DB']);
  const variant = variantByKey(task.key);
  const response = await materializeVariant(
    variant,
    env.MINUTE_DB,
    env.PAGES_RESPONSE_KV,
    pagesEnvironment(env),
    timestamp,
    dependencies,
  );
  return taskResponse(task, timestamp, response);
}
