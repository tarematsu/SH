import {
  loadTrackHistoryData,
  TRACK_HISTORY_GRACE_MS,
} from '../../site/functions/lib/track-history-restored-handler.js';
import { mergeTrackRows } from '../../site/functions/lib/track-history-merge.js';
import { applyTrackPeriodCompleteness } from '../../site/functions/lib/period-completeness.js';
import { attachCompactTrackLikes } from '../../site/functions/lib/track-likes.js';
import {
  mergeTrackHistoryExcludedDates,
  refreshTrackHistoryPagesReadModel,
  trackHistoryRefreshRanges,
} from './pages-read-model-refresh.js';

const DAY_MS = 86_400_000;
const HOUR_MS = 60 * 60_000;
const TRACK_HISTORY_EPOCH = Date.UTC(2024, 4, 1);
const TRACK_HISTORY_LIMIT = 40_000;
const STAGE_KEY = 'track-history-hourly-stage';
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

function validTimestamp(value) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : null;
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

export function createTrackHistoryHourlyStage(now, backfillState = null, previousStatus = {}) {
  const timestamp = Number(now);
  const generation = Math.floor(timestamp / HOUR_MS) * HOUR_MS;
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

async function trackHistoryCoverage(db, range) {
  const fromDay = dayText(range.fromTs);
  const toDay = dayText(range.toTs - 1);
  return db.prepare(`SELECT
      MIN(play_date) AS earliest_date,
      MAX(play_date) AS latest_date,
      COALESCE(SUM(CASE WHEN play_date>=? AND play_date<=? THEN 1 ELSE 0 END),0) AS recent_row_count
    FROM sh_pages_track_history_read_model`)
    .bind(fromDay, toDay)
    .first();
}

function completedResults(stage, kind) {
  return stage.tasks
    .filter((task) => task.kind === kind)
    .map((task) => stage.completed[task.id])
    .filter(Boolean);
}

function fullExcludedDates(results) {
  return [...new Set(results.flatMap((result) => result.excludedDates || []).map(String).filter(Boolean))].sort();
}

function incrementalExcludedDates(stage) {
  let dates = Array.isArray(stage.previous_status?.excluded_play_count_dates)
    ? stage.previous_status.excluded_play_count_dates
    : [];
  for (const task of stage.tasks.filter((item) => item.kind === 'recent')) {
    const result = stage.completed[task.id];
    dates = mergeTrackHistoryExcludedDates(dates, result?.excludedDates, task.range);
  }
  return dates;
}

function backfillStatus(stage, now) {
  const range = stage.ranges.backfill;
  if (!range) {
    return {
      next_to: TRACK_HISTORY_EPOCH,
      completed: true,
      updated_at: now,
    };
  }
  return {
    next_to: range.fromTs,
    completed: range.fromTs <= TRACK_HISTORY_EPOCH,
    updated_at: now,
  };
}

async function finalizeTrackHistoryStage(env, stage, now, dependencies = {}) {
  const targetDb = env.MINUTE_DB;
  const coverage = await (dependencies.coverage || trackHistoryCoverage)(
    targetDb,
    stage.ranges.full_recent,
  );
  const recentResults = completedResults(stage, 'recent');
  const previousSourceRowCount = Number(stage.previous_status?.source_row_count);
  const previousSourceRefreshedAt = validTimestamp(
    stage.previous_status?.source_row_count_refreshed_at
      ?? stage.previous_status?.full_reconciled_at
      ?? stage.previous_status?.generated_at,
  );
  const full = stage.refresh_mode === 'full';
  const sourceRowCount = full || !Number.isFinite(previousSourceRowCount)
    ? recentResults.reduce((sum, result) => sum + (Number(result.sourceRowCount) || 0), 0)
    : previousSourceRowCount;
  const sourceRowCountRefreshedAt = full || previousSourceRefreshedAt == null
    ? now
    : previousSourceRefreshedAt;
  const excludedDates = full
    ? fullExcludedDates(recentResults)
    : incrementalExcludedDates(stage);
  const recentRange = stage.ranges.recent;
  const backfillRange = stage.ranges.backfill;
  const status = {
    ok: true,
    from: coverage?.earliest_date || dayText(recentRange.fromTs),
    to: coverage?.latest_date || dayText(recentRange.toTs - 1),
    row_count: Math.max(0, Number(coverage?.recent_row_count || 0)),
    source_row_count: sourceRowCount,
    source_row_count_refreshed_at: sourceRowCountRefreshedAt,
    source_truncated: false,
    excluded_play_count_dates: excludedDates,
    grace_ms: TRACK_HISTORY_GRACE_MS,
    backfill_completed: !backfillRange || backfillRange.fromTs <= TRACK_HISTORY_EPOCH,
    backfill_from: backfillRange ? dayText(backfillRange.fromTs) : null,
    backfill_to: backfillRange ? dayText(backfillRange.toTs - 1) : null,
    refresh_mode: stage.refresh_mode,
    refresh_from: dayText(recentRange.fromTs),
    refresh_to: dayText(recentRange.toTs - 1),
    full_reconciled_at: full ? now : stage.previous_full_at,
    generated_at: now,
  };
  const save = dependencies.savePayload || savePayload;
  await save(targetDb, BACKFILL_KEY, backfillStatus(stage, now), now);
  await save(targetDb, STATUS_KEY, status, now);

  const publish = dependencies.publish || refreshTrackHistoryPagesReadModel;
  const publication = await publish(env, now, {
    ...dependencies,
    refreshTracks: async () => ({ staged: true, generation: stage.generation }),
  });
  if (Number(publication?.failed || 0) > 0) return { publication, status, published: false };

  stage.published = true;
  stage.published_at = now;
  stage.updated_at = now;
  await save(targetDb, STAGE_KEY, stage, now);
  return { publication, status, published: true };
}

async function loadOrCreateStage(targetDb, now, dependencies = {}) {
  const load = dependencies.loadPayload || loadPayload;
  const save = dependencies.savePayload || savePayload;
  const generation = Math.floor(now / HOUR_MS) * HOUR_MS;
  const existing = await load(targetDb, STAGE_KEY);
  if (existing && !existing.published) return existing;
  if (existing?.generation === generation) return existing;

  const [backfillState, previousStatus] = await Promise.all([
    load(targetDb, BACKFILL_KEY),
    load(targetDb, STATUS_KEY),
  ]);
  const stage = createTrackHistoryHourlyStage(now, backfillState, previousStatus || {});
  await save(targetDb, STAGE_KEY, stage, now);
  return stage;
}

export async function runTrackHistoryHourlyStep(env, now = Date.now(), dependencies = {}) {
  if (!env?.BUDDIES_DB || !env?.MINUTE_DB) {
    throw new Error('track-history hourly step is missing BUDDIES_DB or MINUTE_DB');
  }
  const timestamp = Number(now);
  const stage = await loadOrCreateStage(env.MINUTE_DB, timestamp, dependencies);
  if (stage.published) {
    return {
      skipped: true,
      reason: 'track-history-hour-already-published',
      generated_at: timestamp,
      task: { kind: 'track-history-idle', key: STAGE_KEY, generation: stage.generation },
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
    await save(env.MINUTE_DB, STAGE_KEY, stage, timestamp);
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
