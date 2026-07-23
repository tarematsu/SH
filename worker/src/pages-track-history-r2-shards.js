import {
  loadTrackHistoryData,
  TRACK_HISTORY_SQL,
} from '../../site/functions/lib/track-history-restored-handler.js';
import { mergeTrackRows } from '../../site/functions/lib/track-history-merge.js';
import { applyTrackPeriodCompleteness } from '../../site/functions/lib/period-completeness.js';
import { attachCompactTrackLikes } from '../../site/functions/lib/track-likes.js';
import { boundedTrackHistorySql } from './pages-track-history-stage.js';

const DAY_MS = 86_400_000;
const SHARD_MS = 3 * 60 * 60_000;
const TRACK_HISTORY_LIMIT = 40_000;
const SHARD_PREFIX = 'track-history-shards/v1/';
const SHARD_VERSION = 1;

function validTimestamp(value) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : null;
}

function dayText(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
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
  const boundedSql = boundedTrackHistorySql();
  return new Proxy(db, {
    get(target, property) {
      if (property === 'prepare') {
        return (sql) => target.prepare(sql === TRACK_HISTORY_SQL ? boundedSql : sql);
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export function trackHistoryShardObjectKey(generation, range) {
  const from = validTimestamp(range?.fromTs);
  const to = validTimestamp(range?.toTs);
  if (from == null || to == null || to <= from) throw new Error('invalid track-history shard range');
  return `${SHARD_PREFIX}${generation}/${from}-${to}.json`;
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

async function loadShard(r2, generation, range) {
  const key = trackHistoryShardObjectKey(generation, range);
  const object = await r2.get(key);
  if (!object) throw new Error(`track-history shard is missing: ${key}`);
  const payload = typeof object.json === 'function'
    ? await object.json()
    : JSON.parse(await object.text());
  if (Number(payload?.version) !== SHARD_VERSION
      || Number(payload?.generation) !== Number(generation)
      || Number(payload?.from) !== Number(range.fromTs)
      || Number(payload?.to) !== Number(range.toTs)
      || !Array.isArray(payload?.rows)) {
    throw new Error(`track-history shard is invalid: ${key}`);
  }
  return { key, payload };
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
  await persistDayRows(targetDb, dayRows, dayRange, generation);
  return {
    from: dayText(dayRange.fromTs),
    to: dayText(dayRange.toTs - 1),
    rows: dayRows.length,
    stagedRows: shards.reduce((sum, { payload }) => sum + payload.rows.length, 0),
    groupedRows: groupedRows.length,
    sourceRowCount,
    excludedDates: [...new Set(shards.flatMap(({ payload }) => payload.excluded_dates || []))].sort(),
    cleanupDay: true,
    storage: 'd1-day',
  };
}
