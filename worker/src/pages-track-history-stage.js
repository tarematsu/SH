import {
  loadTrackHistoryData,
  TRACK_HISTORY_GRACE_MS,
} from '../../site/functions/lib/track-history-restored-handler.js';
import { mergeTrackRows } from '../../site/functions/lib/track-history-merge.js';
import { applyTrackPeriodCompleteness } from '../../site/functions/lib/period-completeness.js';
import { attachCompactTrackLikes } from '../../site/functions/lib/track-likes.js';
import { mergeTrackHistoryExcludedDates } from './pages-track-history-support.js';
import { TRACK_HISTORY_STAGE_KEY } from './pages-track-history-cycle.js';

const TRACK_HISTORY_LIMIT = 40_000;
const BACKFILL_KEY = 'track-history-backfill';
const STATUS_KEY = 'track-history-status';
const TRACK_HISTORY_EPOCH = Date.UTC(2024, 4, 1);

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

function validTimestamp(value) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : null;
}

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

async function ensureShardSchema(db) {
  await db.batch(SHARD_SCHEMA_SQL.map((sql) => db.prepare(sql)));
}

async function payloadRow(db, key) {
  return db.prepare(`SELECT payload_json
    FROM sh_pages_payload_read_model
    WHERE model_key=?
    LIMIT 1`).bind(key).first();
}

export async function loadTrackHistoryStage(db) {
  try {
    return parsedPayload(await payloadRow(db, TRACK_HISTORY_STAGE_KEY));
  } catch (error) {
    if (!/no such table/i.test(String(error?.message || error))) throw error;
    await ensureShardSchema(db);
    return null;
  }
}

export async function saveTrackHistoryPayload(db, key, payload, now) {
  await db.prepare(`INSERT INTO sh_pages_payload_read_model(model_key,payload_json,updated_at)
    VALUES(?,?,?) ON CONFLICT(model_key) DO UPDATE SET
      payload_json=excluded.payload_json,updated_at=excluded.updated_at`)
    .bind(key, JSON.stringify(payload), now).run();
}

export function saveTrackHistoryStage(db, stage, now) {
  return saveTrackHistoryPayload(db, TRACK_HISTORY_STAGE_KEY, stage, now);
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
    .map((task) => stage.completed?.[task.id])
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
    const result = stage.completed?.[task.id];
    dates = mergeTrackHistoryExcludedDates(dates, result?.excludedDates, task.range);
  }
  return dates;
}

function backfillStatus(stage, now) {
  const range = stage.ranges.backfill;
  if (!range) return { next_to: TRACK_HISTORY_EPOCH, completed: true, updated_at: now };
  return {
    next_to: range.fromTs,
    completed: range.fromTs <= TRACK_HISTORY_EPOCH,
    updated_at: now,
  };
}

export async function finalizeTrackHistoryStatus(env, stage, now, dependencies = {}) {
  const coverage = await (dependencies.coverage || trackHistoryCoverage)(
    env.MINUTE_DB,
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
  const excludedDates = full ? fullExcludedDates(recentResults) : incrementalExcludedDates(stage);
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
  const save = dependencies.savePayload || saveTrackHistoryPayload;
  await save(env.MINUTE_DB, BACKFILL_KEY, backfillStatus(stage, now), now);
  await save(env.MINUTE_DB, STATUS_KEY, status, now);
  return status;
}

export async function runLateTrackHistoryShard(env, stage, timestamp, dependencies = {}) {
  const nextTask = stage.tasks.find((task) => !stage.completed?.[task.id]);
  if (!nextTask) return null;
  const refreshDay = dependencies.refreshDay || materializeTrackHistoryDay;
  const result = await refreshDay(env.BUDDIES_DB, env.MINUTE_DB, nextTask.range, timestamp);
  stage.completed = { ...(stage.completed || {}), [nextTask.id]: result };
  stage.updated_at = timestamp;
  const save = dependencies.saveStage || saveTrackHistoryStage;
  await save(env.MINUTE_DB, stage, timestamp);
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
