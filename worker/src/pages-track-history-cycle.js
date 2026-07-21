import { loadTrackHistoryData } from '../../site/functions/lib/track-history-restored-handler.js';
import { mergeTrackRows } from '../../site/functions/lib/track-history-merge.js';
import { applyTrackPeriodCompleteness } from '../../site/functions/lib/period-completeness.js';
import { attachCompactTrackLikes } from '../../site/functions/lib/track-likes.js';
import {
  refreshTrackHistoryPagesReadModel,
  trackHistoryRefreshRanges,
} from './pages-track-history-support.js';

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
export const TRACK_HISTORY_CYCLE_MS = 6 * 60 * MINUTE_MS;
export const TRACK_HISTORY_ACTIVE_MINUTES = 60;
const TRACK_HISTORY_LIMIT = 40_000;
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

function parsedPayload(row) {
  try {
    return row?.payload_json ? JSON.parse(row.payload_json) : null;
  } catch {
    return null;
  }
}

function trackRowKey(row) {
  return [
    row.play_date || '',
    row.stationhead_track_id ?? '',
    row.isrc || '',
    row.spotify_id || '',
    row.queue_track_id ?? '',
    row.position ?? '',
    row.first_played_at ?? row.played_at ?? '',
  ].join('|');
}

export function splitTrackHistoryRange(range) {
  if (!range || !Number.isFinite(Number(range.fromTs)) || !Number.isFinite(Number(range.toTs))) return [];
  const ranges = [];
  for (let fromTs = Number(range.fromTs); fromTs < Number(range.toTs); fromTs += DAY_MS) {
    ranges.push({ fromTs, toTs: Math.min(Number(range.toTs), fromTs + DAY_MS) });
  }
  return ranges;
}

function stageTask(kind, range, index) {
  return {
    id: `${kind}:${index}:${dayText(range.fromTs)}`,
    kind,
    range,
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

async function payloadRow(db, key) {
  return db.prepare(`SELECT payload_json
    FROM sh_pages_payload_read_model
    WHERE model_key=?
    LIMIT 1`).bind(key).first();
}

async function loadPayload(db, key) {
  try {
    return parsedPayload(await payloadRow(db, key));
  } catch (error) {
    if (!/no such table/i.test(String(error?.message || error))) throw error;
    await ensureShardSchema(db);
    return null;
  }
}

async function savePayload(db, key, payload, now) {
  await db.prepare(`INSERT INTO sh_pages_payload_read_model(model_key,payload_json,updated_at)
    VALUES(?,?,?) ON CONFLICT(model_key) DO UPDATE SET
      payload_json=excluded.payload_json,updated_at=excluded.updated_at`)
    .bind(key, JSON.stringify(payload), now).run();
}

async function materializeTrackHistoryDay(sourceDb, targetDb, range, now) {
  const { result, likeRows } = await loadTrackHistoryData(
    sourceDb,
    range.fromTs,
    range.toTs,
    TRACK_HISTORY_LIMIT,
    true,
  );
  const groupedRows = result.results || [];
  if (groupedRows.length > TRACK_HISTORY_LIMIT) {
    throw new Error(`track history read-model day exceeded ${TRACK_HISTORY_LIMIT} grouped rows`);
  }
  const mergedRows = mergeTrackRows(groupedRows);
  const likedRows = attachCompactTrackLikes(mergedRows, likeRows);
  const completed = applyTrackPeriodCompleteness(likedRows, groupedRows);
  const rows = completed.rows;
  const fromDay = dayText(range.fromTs);
  const toDay = dayText(range.toTs - 1);
  const statements = rows.map((row) => targetDb.prepare(`INSERT INTO sh_pages_track_history_read_model(
      row_key,play_date,first_played_at,row_json,updated_at
    ) VALUES(?,?,?,?,?) ON CONFLICT(row_key) DO UPDATE SET
      play_date=excluded.play_date,
      first_played_at=excluded.first_played_at,
      row_json=excluded.row_json,
      updated_at=excluded.updated_at`)
    .bind(
      trackRowKey(row),
      row.play_date,
      Number(row.first_played_at || row.played_at || 0) || null,
      JSON.stringify(row),
      now,
    ));
  for (let offset = 0; offset < statements.length; offset += 100) {
    await targetDb.batch(statements.slice(offset, offset + 100));
  }
  await targetDb.prepare(`DELETE FROM sh_pages_track_history_read_model
    WHERE play_date>=? AND play_date<=? AND updated_at<>?`)
    .bind(fromDay, toDay, now).run();
  return {
    from: fromDay,
    to: toDay,
    rows: rows.length,
    groupedRows: groupedRows.length,
    sourceRowCount: groupedRows.reduce((sum, row) => sum + (Number(row.play_count) || 0), 0),
    excludedDates: completed.excludedDates,
  };
}

async function finalizeTrackHistoryStage(env, stage, now, dependencies = {}) {
  const { finalizeTrackHistoryStatus } = await import('./pages-track-history-stage.js');
  const status = await finalizeTrackHistoryStatus(env, stage, now, dependencies);
  const publish = dependencies.publish || refreshTrackHistoryPagesReadModel;
  const publication = await publish(env, now, {
    ...dependencies,
    refreshTracks: async () => ({ staged: true, generation: stage.generation }),
  });
  if (Number(publication?.failed || 0) > 0) return { publication, status, published: false };

  stage.published = true;
  stage.published_at = now;
  stage.updated_at = now;
  const save = dependencies.savePayload || savePayload;
  await save(env.MINUTE_DB, TRACK_HISTORY_STAGE_KEY, stage, now);
  return { publication, status, published: true };
}

async function loadOrCreateStage(targetDb, now, dependencies = {}) {
  const load = dependencies.loadPayload || loadPayload;
  const save = dependencies.savePayload || savePayload;
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
        key: TRACK_HISTORY_STAGE_KEY,
        cycle_start: cycleStart,
        cycle_minute: cycleMinute,
      },
      responses: [],
      failed: 0,
    };
  }
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
  if (nextTask) {
    const refreshDay = dependencies.refreshDay || materializeTrackHistoryDay;
    const result = await refreshDay(env.BUDDIES_DB, env.MINUTE_DB, nextTask.range, timestamp);
    stage.completed = { ...(stage.completed || {}), [nextTask.id]: result };
    stage.updated_at = timestamp;
    const save = dependencies.savePayload || savePayload;
    await save(env.MINUTE_DB, TRACK_HISTORY_STAGE_KEY, stage, timestamp);
    return {
      skipped: false,
      generated_at: timestamp,
      task: {
        kind: 'track-history-shard',
        key: nextTask.id,
        generation: stage.generation,
        shard_kind: nextTask.kind,
        from: result.from,
        to: result.to,
      },
      shard: result,
      completed: Object.keys(stage.completed).length,
      total: stage.tasks.length,
      responses: [],
      failed: 0,
    };
  }

  const finalized = await finalizeTrackHistoryStage(env, stage, timestamp, dependencies);
  return {
    skipped: false,
    generated_at: timestamp,
    task: {
      kind: 'track-history-publish',
      key: 'track-history',
      generation: stage.generation,
    },
    stage: {
      refresh_mode: stage.refresh_mode,
      shards: stage.tasks.length,
      published: finalized.published,
    },
    responses: finalized.publication?.responses || [],
    succeeded: Number(finalized.publication?.succeeded || 0),
    failed: Number(finalized.publication?.failed || 0),
  };
}
