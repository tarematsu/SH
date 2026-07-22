import { trackHistoryRefreshRanges } from './pages-track-history-support.js';

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
export const TRACK_HISTORY_CYCLE_MS = 6 * 60 * MINUTE_MS;
export const TRACK_HISTORY_SHARD_MS = 6 * 60 * MINUTE_MS;
export const TRACK_HISTORY_ACTIVE_MINUTES = 60;
export const TRACK_HISTORY_STAGE_KEY = 'track-history-cycle-stage';
const BACKFILL_KEY = 'track-history-backfill';
const STATUS_KEY = 'track-history-status';

const SHARD_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS sh_pages_payload_read_model (
    model_key TEXT PRIMARY KEY,
    payload_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sh_pages_track_history_read_model (
    row_key TEXT PRIMARY KEY,
    play_date TEXT NOT NULL,
    first_played_at INTEGER,
    row_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sh_pages_track_history_date
    ON sh_pages_track_history_read_model(play_date,first_played_at,row_key)`,
];

function dayText(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function shardText(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 13);
}

function parsedPayload(row) {
  try {
    return row?.payload_json ? JSON.parse(row.payload_json) : null;
  } catch {
    return null;
  }
}

export function splitTrackHistoryRange(range) {
  if (!range || !Number.isFinite(Number(range.fromTs)) || !Number.isFinite(Number(range.toTs))) return [];
  const ranges = [];
  for (let fromTs = Number(range.fromTs); fromTs < Number(range.toTs); fromTs += TRACK_HISTORY_SHARD_MS) {
    ranges.push({ fromTs, toTs: Math.min(Number(range.toTs), fromTs + TRACK_HISTORY_SHARD_MS) });
  }
  return ranges;
}

function stageTask(kind, range, index) {
  return {
    id: `${kind}:${index}:${shardText(range.fromTs)}`,
    kind,
    range,
    cleanup_day: Number(range.toTs) % DAY_MS === 0,
  };
}

export function createTrackHistoryCycleStage(now, backfillState = null, previousStatus = {}) {
  const timestamp = Number(now);
  const generation = Math.floor(timestamp / TRACK_HISTORY_CYCLE_MS) * TRACK_HISTORY_CYCLE_MS;
  const ranges = trackHistoryRefreshRanges(timestamp, backfillState, previousStatus);
  const recentTasks = splitTrackHistoryRange(ranges.recent)
    .map((range, index) => stageTask('recent', range, index));
  const backfillTasks = splitTrackHistoryRange(ranges.backfill)
    .map((range, index) => stageTask('backfill', range, index));
  return {
    generation,
    created_at: timestamp,
    updated_at: timestamp,
    published: false,
    published_at: null,
    refresh_mode: ranges.fullReconcile ? 'full' : 'incremental',
    previous_full_at: ranges.previousFullAt,
    previous_status: previousStatus || {},
    ranges: {
      recent: ranges.recent,
      full_recent: ranges.fullRecent,
      backfill: ranges.backfill,
    },
    tasks: [...recentTasks, ...backfillTasks],
    completed: {},
  };
}

async function ensureShardSchema(db) {
  await db.batch(SHARD_SCHEMA_SQL.map((sql) => db.prepare(sql)));
}

async function defaultLoadPayload(db, key) {
  try {
    const row = await db.prepare(`SELECT payload_json
      FROM sh_pages_payload_read_model
      WHERE model_key=?
      LIMIT 1`).bind(key).first();
    return parsedPayload(row);
  } catch (error) {
    if (!/no such table/i.test(String(error?.message || error))) throw error;
    await ensureShardSchema(db);
    return null;
  }
}

async function defaultSavePayload(db, key, payload, now) {
  await db.prepare(`INSERT INTO sh_pages_payload_read_model(model_key,payload_json,updated_at)
    VALUES(?,?,?) ON CONFLICT(model_key) DO UPDATE SET
    payload_json=excluded.payload_json,updated_at=excluded.updated_at`)
    .bind(key, JSON.stringify(payload), now).run();
}

async function loadOrCreateStage(targetDb, now, dependencies = {}) {
  const load = dependencies.loadPayload || defaultLoadPayload;
  const save = dependencies.savePayload || defaultSavePayload;
  const generation = Math.floor(now / TRACK_HISTORY_CYCLE_MS) * TRACK_HISTORY_CYCLE_MS;
  const existing = await load(targetDb, TRACK_HISTORY_STAGE_KEY);
  if (existing && !existing.published) {
    if (existing.generation !== generation) {
      existing.generation = generation;
      existing.updated_at = now;
      await save(targetDb, TRACK_HISTORY_STAGE_KEY, existing, now);
    }
    return existing;
  }
  if (existing?.generation === generation) return existing;

  const [backfillState, previousStatus] = await Promise.all([
    load(targetDb, BACKFILL_KEY),
    load(targetDb, STATUS_KEY),
  ]);
  const stage = createTrackHistoryCycleStage(now, backfillState, previousStatus || {});
  await save(targetDb, TRACK_HISTORY_STAGE_KEY, stage, now);
  return stage;
}

function idleResult(timestamp, cycleStart, cycleMinute) {
  return {
    skipped: true,
    reason: 'track-history-cycle-idle',
    generated_at: timestamp,
    task: {
      kind: 'track-history-idle',
      key: TRACK_HISTORY_STAGE_KEY,
      cycle_start: cycleStart,
      cycle_minute: cycleMinute,
    },
    responses: [],
    failed: 0,
  };
}

export async function runTrackHistoryCycleStep(env, now = Date.now(), dependencies = {}) {
  const timestamp = Number(now);
  const cycleStart = Math.floor(timestamp / TRACK_HISTORY_CYCLE_MS) * TRACK_HISTORY_CYCLE_MS;
  const cycleMinute = Math.floor((timestamp - cycleStart) / MINUTE_MS);
  if (cycleMinute >= TRACK_HISTORY_ACTIVE_MINUTES) return idleResult(timestamp, cycleStart, cycleMinute);
  if (!env?.BUDDIES_DB || !env?.MINUTE_DB) {
    throw new Error('track-history cycle step is missing BUDDIES_DB or MINUTE_DB');
  }

  const stage = await loadOrCreateStage(env.MINUTE_DB, timestamp, dependencies);
  if (stage.published) {
    return {
      skipped: true,
      reason: 'track-history-cycle-already-published',
      generated_at: timestamp,
      task: { kind: 'track-history-idle', key: TRACK_HISTORY_STAGE_KEY, generation: stage.generation },
      responses: [],
      failed: 0,
    };
  }

  const nextTask = stage.tasks.find((task) => !stage.completed?.[task.id]);
  if (!nextTask) {
    return {
      skipped: true,
      reason: 'track-history-shards-complete',
      generated_at: timestamp,
      task: { kind: 'track-history-publish-ready', key: 'track-history', generation: stage.generation },
      responses: [],
      failed: 0,
    };
  }

  const { runLateTrackHistoryShard } = await import('./pages-track-history-stage.js');
  const save = dependencies.savePayload || defaultSavePayload;
  return runLateTrackHistoryShard(env, stage, timestamp, {
    ...dependencies,
    saveStage: dependencies.saveStage
      || ((db, nextStage, at) => save(db, TRACK_HISTORY_STAGE_KEY, nextStage, at)),
  });
}
