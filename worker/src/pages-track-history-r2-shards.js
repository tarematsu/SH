import {
  loadTrackHistoryData,
  TRACK_HISTORY_SQL,
} from '../../site/functions/lib/track-history-restored-handler.js';
import { mergeTrackRows } from '../../site/functions/lib/track-history-merge.js';
import { applyTrackPeriodCompleteness } from '../../site/functions/lib/period-completeness.js';
import { attachCompactTrackLikes } from '../../site/functions/lib/track-likes.js';
import {
  trackHistoryResponsePrefix,
  trackHistoryResponseSuffix,
} from './pages-track-history-response.js';
import { saveMaterializedR2Response } from './pages-response-r2.js';

const DAY_MS = 86_400_000;
const SHARD_MS = 3 * 60 * 60_000;
const TRACK_HISTORY_LIMIT = 40_000;
const TRACK_HISTORY_QUEUE_LOOKBACK_MS = 2 * DAY_MS;
const SHARD_PREFIX = 'track-history-shards/v1/';
const SHARD_VERSION = 1;
const DAY_MODEL_PREFIX = 'track-history-days/v1/';
const DAY_MODEL_VERSION = 1;
const RAW_QUEUE_STARTS_SQL = `WITH RECURSIVE queue_starts AS (
      SELECT DISTINCT station_id,start_time
      FROM sh_queue_items
      WHERE start_time IS NOT NULL AND start_time < ?
    )`;
const MATERIALIZED_QUEUE_STARTS_SQL = `WITH RECURSIVE queue_bounds AS (
      SELECT ? AS range_end
    ), queue_starts AS (
      SELECT starts.station_id,starts.start_time
      FROM sh_track_history_queue_starts starts
      CROSS JOIN queue_bounds bounds
      WHERE starts.start_time>=bounds.range_end-${TRACK_HISTORY_QUEUE_LOOKBACK_MS}
        AND starts.start_time<bounds.range_end
    )`;
const MATERIALIZED_TRACK_HISTORY_SQL = TRACK_HISTORY_SQL.replace(
  RAW_QUEUE_STARTS_SQL,
  MATERIALIZED_QUEUE_STARTS_SQL,
);

if (MATERIALIZED_TRACK_HISTORY_SQL === TRACK_HISTORY_SQL) {
  throw new Error('track-history materialized queue-start rewrite did not match');
}

function validTimestamp(value) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : null;
}

function dayText(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function dayTimestamp(value) {
  const timestamp = Date.parse(`${String(value || '')}T00:00:00Z`);
  return Number.isFinite(timestamp) ? timestamp : null;
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

function boundedTrackHistoryDatabase(db) {
  return new Proxy(db, {
    get(target, property) {
      if (property === 'prepare') {
        return (sql) => target.prepare(sql === TRACK_HISTORY_SQL ? MATERIALIZED_TRACK_HISTORY_SQL : sql);
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export function materializedTrackHistorySql() {
  return MATERIALIZED_TRACK_HISTORY_SQL;
}

export function trackHistoryShardObjectKey(generation, range) {
  const from = validTimestamp(range?.fromTs);
  const to = validTimestamp(range?.toTs);
  if (from == null || to == null || to <= from) throw new Error('invalid track-history shard range');
  return `${SHARD_PREFIX}${generation}/${from}-${to}.json`;
}

export function trackHistoryDayObjectKey(day) {
  const timestamp = dayTimestamp(day);
  if (timestamp == null) throw new Error('invalid track-history day');
  return `${DAY_MODEL_PREFIX}${dayText(timestamp)}.json`;
}

export function trackHistoryDayShardRanges(range) {
  const from = validTimestamp(range?.fromTs);
  const to = validTimestamp(range?.toTs);
  if (from == null || to == null || to <= from) return [];
  const dayStart = Math.floor(from / DAY_MS) * DAY_MS;
  const dayEnd = dayStart + DAY_MS;
  if (to > dayEnd) throw new Error('track-history shard crossed a UTC day boundary');
  const ranges = [];
  for (let cursor = dayStart; cursor < dayEnd; cursor += SHARD_MS) {
    ranges.push({ fromTs: cursor, toTs: Math.min(dayEnd, cursor + SHARD_MS) });
  }
  return ranges;
}

async function saveShard(r2, generation, range, payload) {
  const key = trackHistoryShardObjectKey(generation, range);
  await r2.put(key, JSON.stringify({
    version: SHARD_VERSION,
    generation,
    from: range.fromTs,
    to: range.toTs,
    ...payload,
  }), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
  });
  return key;
}

async function loadJsonObject(r2, key) {
  const object = await r2.get(key);
  if (!object) return null;
  return typeof object.json === 'function'
    ? object.json()
    : JSON.parse(await object.text());
}

async function loadShard(r2, generation, range) {
  const key = trackHistoryShardObjectKey(generation, range);
  const payload = await loadJsonObject(r2, key);
  if (!payload) throw new Error(`track-history shard is missing: ${key}`);
  if (Number(payload?.version) !== SHARD_VERSION
      || Number(payload?.generation) !== Number(generation)
      || Number(payload?.from) !== Number(range.fromTs)
      || Number(payload?.to) !== Number(range.toTs)
      || !Array.isArray(payload?.rows)) {
    throw new Error(`track-history shard is invalid: ${key}`);
  }
  return { key, payload };
}

export async function saveTrackHistoryDayReadModel(r2, range, rows, metadata = {}) {
  const from = validTimestamp(range?.fromTs);
  const to = validTimestamp(range?.toTs);
  if (from == null || to == null || to - from !== DAY_MS) {
    throw new Error('track-history day read-model range is invalid');
  }
  const day = dayText(from);
  const key = trackHistoryDayObjectKey(day);
  const sortedRows = [...(rows || [])].sort((left, right) => (
    Number(left?.first_played_at ?? left?.played_at ?? 0)
      - Number(right?.first_played_at ?? right?.played_at ?? 0)
      || trackRowKey(left).localeCompare(trackRowKey(right))
  ));
  await r2.put(key, JSON.stringify({
    version: DAY_MODEL_VERSION,
    day,
    updated_at: validTimestamp(metadata.updated_at) ?? Date.now(),
    rows: sortedRows,
    source_row_count: Math.max(0, Number(metadata.source_row_count || 0)),
    excluded_dates: Array.isArray(metadata.excluded_dates) ? metadata.excluded_dates : [],
  }), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
  });
  return { key, day, rows: sortedRows.length };
}

export async function loadTrackHistoryDayReadModel(r2, day) {
  const key = trackHistoryDayObjectKey(day);
  const payload = await loadJsonObject(r2, key);
  if (!payload) return null;
  if (Number(payload?.version) !== DAY_MODEL_VERSION
      || String(payload?.day || '') !== String(day)
      || !Array.isArray(payload?.rows)) {
    throw new Error(`track-history day read-model is invalid: ${key}`);
  }
  return { key, payload };
}

export async function bootstrapTrackHistoryDayReadModel(db, r2, day, now = Date.now()) {
  const result = await db.prepare(`SELECT row_json,json_valid(row_json) AS row_json_valid
    FROM sh_pages_track_history_read_model
    WHERE play_date=?
    ORDER BY COALESCE(first_played_at,-1) ASC,row_key ASC
    LIMIT ?`).bind(day, TRACK_HISTORY_LIMIT + 1).all();
  const rawRows = result.results || [];
  if (rawRows.length > TRACK_HISTORY_LIMIT) {
    throw new Error(`track-history day ${day} exceeded ${TRACK_HISTORY_LIMIT} rows`);
  }
  const rows = rawRows.map((row) => {
    if (row.row_json_valid != null && Number(row.row_json_valid) !== 1) {
      throw new Error(`track-history day ${day} contained invalid JSON`);
    }
    return JSON.parse(String(row.row_json || 'null'));
  });
  const fromTs = dayTimestamp(day);
  return saveTrackHistoryDayReadModel(
    r2,
    { fromTs, toTs: fromTs + DAY_MS },
    rows,
    { updated_at: now },
  );
}

export async function publishTrackHistoryResponseFromR2Days(
  r2,
  publication,
  now,
  cadenceSeconds,
) {
  const fromTs = dayTimestamp(publication?.from);
  const toTs = dayTimestamp(publication?.to);
  if (fromTs == null || toTs == null || toTs < fromTs) {
    throw new Error('track-history publication date range is invalid');
  }
  const limit = Math.max(1, Number(publication?.limit || 10_000));
  const rows = [];
  let truncated = false;
  for (let cursor = fromTs; cursor <= toTs; cursor += DAY_MS) {
    const day = dayText(cursor);
    const model = await loadTrackHistoryDayReadModel(r2, day);
    if (!model) return { published: false, missing_day: day, rows: rows.length };
    for (const row of model.payload.rows) {
      if (rows.length >= limit) {
        truncated = true;
        break;
      }
      rows.push(row);
    }
    if (truncated) break;
  }
  const completedPublication = { ...publication, truncated };
  const body = `${trackHistoryResponsePrefix(completedPublication)}${rows
    .map((row) => JSON.stringify(row)).join(',')}${trackHistoryResponseSuffix(completedPublication)}`;
  const saved = await saveMaterializedR2Response(
    r2,
    publication.model_key,
    body,
    200,
    { 'content-type': 'application/json; charset=utf-8' },
    now,
    cadenceSeconds,
  );
  return { published: true, rows: rows.length, truncated, ...saved };
}

async function persistDayRows(targetDb, rows, range, generation) {
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
      generation,
    ));
  for (let offset = 0; offset < statements.length; offset += 100) {
    await targetDb.batch(statements.slice(offset, offset + 100));
  }
  await targetDb.prepare(`DELETE FROM sh_pages_track_history_read_model
    WHERE play_date>=? AND play_date<=? AND updated_at<>?`)
    .bind(dayText(range.fromTs), dayText(range.toTs - 1), generation)
    .run();
}

export async function materializeTrackHistoryRangeThroughR2(
  _sourceDb,
  targetDb,
  range,
  now,
  options = {},
) {
  const r2 = options.r2;
  if (!r2?.put || !r2?.get) throw new Error('track-history R2 staging binding is missing');
  const generation = validTimestamp(options.generation) ?? validTimestamp(now) ?? Date.now();
  const load = options.loadData || loadTrackHistoryData;
  const merge = options.mergeRows || mergeTrackRows;
  const attachLikes = options.attachLikes || attachCompactTrackLikes;
  const complete = options.applyCompleteness || applyTrackPeriodCompleteness;
  const { result, likeRows } = await load(
    boundedTrackHistoryDatabase(targetDb),
    range.fromTs,
    range.toTs,
    TRACK_HISTORY_LIMIT,
    true,
  );
  const groupedRows = result.results || [];
  if (groupedRows.length > TRACK_HISTORY_LIMIT) {
    throw new Error(`track history read-model shard exceeded ${TRACK_HISTORY_LIMIT} grouped rows`);
  }
  const completed = complete(attachLikes(merge(groupedRows), likeRows), groupedRows);
  const sourceRowCount = groupedRows.reduce(
    (sum, row) => sum + (Number(row.play_count) || 0),
    0,
  );
  await saveShard(r2, generation, range, {
    rows: completed.rows,
    grouped_rows: groupedRows.length,
    source_row_count: sourceRowCount,
    excluded_dates: completed.excludedDates,
  });

  const cleanupDay = options.cleanupDay !== false;
  if (!cleanupDay) {
    return {
      from: dayText(range.fromTs),
      to: dayText(range.toTs - 1),
      rows: 0,
      stagedRows: completed.rows.length,
      groupedRows: groupedRows.length,
      sourceRowCount,
      excludedDates: completed.excludedDates,
      cleanupDay: false,
      storage: 'r2-shard',
    };
  }

  const dayRanges = trackHistoryDayShardRanges(range);
  const shards = await Promise.all(dayRanges.map((item) => loadShard(r2, generation, item)));
  const dayRows = merge(shards.flatMap(({ payload }) => payload.rows));
  const dayRange = { fromTs: dayRanges[0].fromTs, toTs: dayRanges.at(-1).toTs };
  const daySourceRowCount = shards.reduce(
    (sum, { payload }) => sum + Number(payload.source_row_count || 0),
    0,
  );
  const dayExcludedDates = [...new Set(
    shards.flatMap(({ payload }) => payload.excluded_dates || []),
  )].sort();
  await saveTrackHistoryDayReadModel(r2, dayRange, dayRows, {
    updated_at: generation,
    source_row_count: daySourceRowCount,
    excluded_dates: dayExcludedDates,
  });
  await persistDayRows(targetDb, dayRows, dayRange, generation);
  return {
    from: dayText(dayRange.fromTs),
    to: dayText(dayRange.toTs - 1),
    rows: dayRows.length,
    stagedRows: shards.reduce((sum, { payload }) => sum + payload.rows.length, 0),
    groupedRows: groupedRows.length,
    sourceRowCount,
    excludedDates: dayExcludedDates,
    cleanupDay: true,
    storage: 'r2-day+d1-day',
  };
}
