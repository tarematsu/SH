import {
  MATERIALIZED_API_VARIANTS,
  materializedResponseCadenceSeconds,
} from '../../site/functions/lib/api-contract.js';
import { loadLikeRanking } from '../../site/functions/api/like-ranking.js';
import { runTrackHistoryCycleStep } from './pages-track-history-cycle.js';
import { saveMaterializedResponse } from './pages-response-store.js';

const MINUTE_MS = 60_000;
export const PAGES_READ_MODEL_CYCLE_MINUTES = 6 * 60;
export const PAGES_READ_MODEL_CYCLE_MS = PAGES_READ_MODEL_CYCLE_MINUTES * MINUTE_MS;
export const TRACK_HISTORY_WINDOW_MINUTES = 60;
const LIKE_RANKING_LIMIT = 500;

const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS sh_pages_payload_read_model (
    model_key TEXT PRIMARY KEY,
    payload_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
];

// One response-generation task per slot. The gaps are intentional: they leave
// track-history enough resumable shard slots while keeping expensive API
// renders separated across the six-hour cycle.
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
    key: 'six-hour-cycle-idle',
    cycle_minute: cycleMinute,
    cycle_start: cycleStart,
  };
}

export function pagesSixHourTask(now = Date.now()) {
  const timestamp = validTimestamp(now);
  const { cycleStart, cycleMinute } = cyclePosition(timestamp);
  const key = CYCLE_SLOT_TASKS.get(cycleMinute) || null;
  if (!key) return backgroundTask(cycleMinute, cycleStart);

  // Host summary remains daily. Its 00:50 UTC slot is preserved in the first
  // six-hour cycle; the same slot in later cycles is available to track history.
  if (key === 'host-history:summary' && new Date(cycleStart).getUTCHours() !== 0) {
    return backgroundTask(cycleMinute, cycleStart);
  }

  const task = {
    key,
    cycle_minute: cycleMinute,
    cycle_start: cycleStart,
  };
  if (key === 'source:like-ranking') return { kind: 'source', ...task };
  return { kind: 'variant', ...task };
}

async function ensureSchema(db) {
  for (const sql of SCHEMA_SQL) await db.prepare(sql).run();
}

async function savePayload(db, key, payload, now) {
  await db.prepare(`INSERT INTO sh_pages_payload_read_model(model_key,payload_json,updated_at)
    VALUES(?,?,?) ON CONFLICT(model_key) DO UPDATE SET
      payload_json=excluded.payload_json,updated_at=excluded.updated_at`)
    .bind(key, JSON.stringify(payload), now).run();
}

async function payloadUpdatedAt(db, key) {
  const row = await db.prepare(`SELECT updated_at
    FROM sh_pages_payload_read_model
    WHERE model_key=?
    LIMIT 1`).bind(key).first();
  const updatedAt = Number(row?.updated_at);
  return Number.isFinite(updatedAt) && updatedAt >= 0 ? updatedAt : null;
}

async function refreshLikeRankingPayload(db, now) {
  const ranking = await loadLikeRanking(db, { limit: LIKE_RANKING_LIMIT });
  const payload = {
    ok: true,
    mode: 'likes',
    generated_at: now,
    limit: LIKE_RANKING_LIMIT,
    filter: 'artist_starts_sakurazaka_or_isrc_starts_jp',
    counter_name: 'like/bite',
    source: 'stationhead-minute.sh_pages_payload_read_model',
    ...ranking,
  };
  await savePayload(db, 'like-ranking', payload, now);
  return { rows: ranking.rows.length };
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
  if (!variant) throw new Error(`unsupported six-hour Pages task: ${key}`);
  return variant;
}

async function responseHandler(modelKey) {
  if (modelKey === 'dashboard-history') return (await import('../../site/functions/api/dashboard-history.js')).onRequestGet;
  if (modelKey === 'track-likes') return (await import('../../site/functions/api/track-likes.js')).onRequestGet;
  if (modelKey === 'like-ranking') return (await import('../../site/functions/api/like-ranking.js')).onRequestGet;
  if (modelKey === 'minute-facts-current') return (await import('../../site/functions/api/minute-facts/current.js')).onRequestGet;
  if (modelKey.startsWith('history:')) return (await import('../../site/functions/api/history.js')).onRequestGet;
  if (modelKey === 'host-history:summary') return (await import('../../site/functions/api/host-history.js')).onRequestGet;
  throw new Error(`unsupported six-hour Pages variant: ${modelKey}`);
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
      reason: 'six-hour-cycle-idle',
      generated_at: timestamp,
      task,
      responses: [],
      failed: 0,
    };
  }

  if (task.kind === 'track-history-step') {
    requireBindings(env, ['BUDDIES_DB', 'MINUTE_DB']);
    const runStep = dependencies.runTrackHistoryStep || runTrackHistoryCycleStep;
    return runStep(env, timestamp, dependencies);
  }

  requireBindings(env, ['BUDDIES_DB', 'MINUTE_DB', 'OTHER_DB']);
  await (dependencies.ensureSchema || ensureSchema)(env.MINUTE_DB);

  if (task.kind === 'source') {
    const refresh = dependencies.refreshLikeRanking || refreshLikeRankingPayload;
    const source = await refresh(env.MINUTE_DB, timestamp);
    return { skipped: false, generated_at: timestamp, task, source, responses: [], failed: 0 };
  }

  if (task.key === 'like-ranking') {
    const readUpdatedAt = dependencies.payloadUpdatedAt || payloadUpdatedAt;
    const updatedAt = await readUpdatedAt(env.MINUTE_DB, 'like-ranking');
    if (updatedAt == null || updatedAt < task.cycle_start) {
      return taskResponse(task, timestamp, {
        key: task.key,
        ok: false,
        error: 'like-ranking source was not refreshed in the current six-hour cycle',
      });
    }
  }

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
