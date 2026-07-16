import {
  UTC_DAILY_METRICS_SQL,
  dailyChangesFromRows,
  utcDayStarts,
} from '../../site/functions/api/dashboard-daily-changes.js';
import { loadLikeRanking } from '../../site/functions/api/like-ranking.js';
import {
  loadTrackHistoryData,
  TRACK_HISTORY_GRACE_MS,
} from '../../site/functions/lib/track-history-restored-handler.js';
import { mergeTrackRows } from '../../site/functions/lib/track-history-merge.js';
import { applyTrackPeriodCompleteness } from '../../site/functions/lib/period-completeness.js';
import { attachCompactTrackLikes } from '../../site/functions/lib/track-likes.js';

const DAY_MS = 86_400_000;
const TRACK_HISTORY_DAYS = 35;
const TRACK_HISTORY_EPOCH = Date.UTC(2024, 4, 1);
const TRACK_HISTORY_LIMIT = 40_000;
const LIKE_RANKING_LIMIT = 500;

const SCHEMA_SQL = [
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

async function ensureSchema(db) {
  for (const sql of SCHEMA_SQL) await db.prepare(sql).run();
}

async function savePayload(db, key, payload, now) {
  await db.prepare(`INSERT INTO sh_pages_payload_read_model(model_key,payload_json,updated_at)
    VALUES(?,?,?) ON CONFLICT(model_key) DO UPDATE SET
      payload_json=excluded.payload_json,updated_at=excluded.updated_at`)
    .bind(key, JSON.stringify(payload), now).run();
}

async function payloadRow(db, key) {
  return db.prepare(`SELECT payload_json
    FROM sh_pages_payload_read_model
    WHERE model_key=?
    LIMIT 1`).bind(key).first();
}

async function refreshDailyChanges(db, now) {
  const starts = utcDayStarts(now);
  const result = await db.prepare(UTC_DAILY_METRICS_SQL)
    .bind(starts.threeDaysAgoStart, starts.dayBeforeYesterdayStart, starts.yesterdayStart)
    .all();
  const payload = {
    ok: true,
    ...dailyChangesFromRows(result.results || [], starts),
    generated_at: now,
  };
  await savePayload(db, 'dashboard-daily-changes', payload, now);
  return { rows: result.results?.length || 0 };
}

async function refreshLikeRanking(db, now) {
  const ranking = await loadLikeRanking(db, { limit: LIKE_RANKING_LIMIT });
  await savePayload(db, 'like-ranking', {
    ok: true,
    mode: 'likes',
    generated_at: now,
    limit: LIKE_RANKING_LIMIT,
    filter: 'artist_starts_sakurazaka_or_isrc_starts_jp',
    counter_name: 'like/bite',
    source: 'stationhead-minute.sh_pages_payload_read_model',
    ...ranking,
  }, now);
  return { rows: ranking.rows.length };
}

async function refreshTrackHistory(sourceDb, targetDb, now) {
  const currentDayStart = Math.floor(now / DAY_MS) * DAY_MS;
  const previousStatus = await payloadRow(targetDb, 'track-history-status');
  const fromTs = previousStatus?.payload_json
    ? currentDayStart - TRACK_HISTORY_DAYS * DAY_MS
    : TRACK_HISTORY_EPOCH;
  const toTs = currentDayStart + DAY_MS;
  const { result, likeRows } = await loadTrackHistoryData(
    sourceDb,
    fromTs,
    toTs,
    TRACK_HISTORY_LIMIT,
    true,
  );
  const groupedRows = result.results || [];
  const sourceTruncated = groupedRows.length > TRACK_HISTORY_LIMIT;
  const sourceRows = sourceTruncated ? groupedRows.slice(0, TRACK_HISTORY_LIMIT) : groupedRows;
  const mergedRows = mergeTrackRows(sourceRows);
  const likedRows = attachCompactTrackLikes(mergedRows, likeRows);
  const completed = applyTrackPeriodCompleteness(likedRows, sourceRows);
  const rows = completed.rows;

  const fromDay = dayText(fromTs);
  const toDay = dayText(toTs - DAY_MS);
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

  await savePayload(targetDb, 'track-history-status', {
    ok: true,
    from: fromDay,
    to: toDay,
    row_count: rows.length,
    source_row_count: sourceRows.reduce((sum, row) => sum + (Number(row.play_count) || 0), 0),
    source_truncated: sourceTruncated,
    excluded_play_count_dates: completed.excludedDates,
    grace_ms: TRACK_HISTORY_GRACE_MS,
    generated_at: now,
  }, now);
  return { rows: rows.length, groupedRows: sourceRows.length, sourceTruncated };
}

export async function refreshPagesReadModels(env, now = Date.now()) {
  const sourceDb = env?.BUDDIES_DB;
  const targetDb = env?.MINUTE_DB;
  if (!sourceDb || !targetDb) return { skipped: true, reason: 'db-binding-missing' };
  await ensureSchema(targetDb);

  const [daily, likes, tracks] = await Promise.all([
    refreshDailyChanges(targetDb, now),
    refreshLikeRanking(targetDb, now),
    refreshTrackHistory(sourceDb, targetDb, now),
  ]);
  return { skipped: false, daily, likes, tracks };
}
