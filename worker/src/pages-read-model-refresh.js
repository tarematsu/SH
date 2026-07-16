import { MATERIALIZED_API_VARIANTS } from '../../site/functions/lib/api-contract.js';
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
const TRACK_HISTORY_BACKFILL_DAYS = 7;
const TRACK_HISTORY_EPOCH = Date.UTC(2024, 4, 1);
const TRACK_HISTORY_LIMIT = 40_000;
const LIKE_RANKING_LIMIT = 500;
const RESPONSE_CHUNK_SIZE = 192_000;
const RESPONSE_MAX_CHUNKS = 80;

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
  `CREATE TABLE IF NOT EXISTS sh_pages_response_manifest (
    model_key TEXT PRIMARY KEY,
    generation TEXT NOT NULL,
    status INTEGER NOT NULL,
    headers_json TEXT NOT NULL,
    chunk_count INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sh_pages_response_chunks (
    model_key TEXT NOT NULL,
    generation TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    payload_chunk TEXT NOT NULL,
    PRIMARY KEY(model_key,generation,chunk_index)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sh_pages_response_chunks_generation
    ON sh_pages_response_chunks(model_key,generation,chunk_index)`,
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

function parsedPayload(row) {
  try {
    return row?.payload_json ? JSON.parse(row.payload_json) : null;
  } catch {
    return null;
  }
}

export function trackHistoryRefreshRanges(now, backfillState = null) {
  const currentDayStart = Math.floor(now / DAY_MS) * DAY_MS;
  const recentFrom = currentDayStart - TRACK_HISTORY_DAYS * DAY_MS;
  const recent = { fromTs: recentFrom, toTs: currentDayStart + DAY_MS };
  const storedCursor = Number(backfillState?.next_to);
  const backfillTo = Math.min(
    Number.isFinite(storedCursor) ? storedCursor : recentFrom,
    recentFrom,
  );
  if (backfillTo <= TRACK_HISTORY_EPOCH) return { recent, backfill: null };
  return {
    recent,
    backfill: {
      fromTs: Math.max(TRACK_HISTORY_EPOCH, backfillTo - TRACK_HISTORY_BACKFILL_DAYS * DAY_MS),
      toTs: backfillTo,
    },
  };
}

export function materializedVariantDue(variant, now = Date.now()) {
  const cadenceMinutes = Math.max(1, Math.trunc(Number(variant?.cadence_minutes) || 5));
  const absoluteMinute = Math.floor(Number(now) / 60_000);
  return Number.isFinite(absoluteMinute) && absoluteMinute % cadenceMinutes === 0;
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

function pagesEnvironment(env = {}) {
  const active = Object.create(env || null);
  Object.defineProperty(active, 'DB', {
    value: env.BUDDIES_DB || env.DB || null,
    enumerable: true,
  });
  return active;
}

function splitResponseBody(body) {
  const chunks = [];
  let offset = 0;
  while (offset < body.length) {
    let end = Math.min(body.length, offset + RESPONSE_CHUNK_SIZE);
    const last = body.charCodeAt(end - 1);
    if (end < body.length && last >= 0xD800 && last <= 0xDBFF) end -= 1;
    chunks.push(body.slice(offset, end));
    offset = end;
  }
  return chunks.length ? chunks : [''];
}

function persistedHeaders(response) {
  const headers = {};
  for (const [key, value] of response.headers.entries()) {
    const normalized = key.toLowerCase();
    if (normalized === 'cache-control' || normalized === 'content-length' || normalized === 'transfer-encoding') continue;
    headers[key] = value;
  }
  if (!headers['content-type']) headers['content-type'] = 'application/json; charset=utf-8';
  return headers;
}

async function saveResponse(db, modelKey, response, now) {
  const body = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error(`${modelKey} did not return JSON`);
  }
  if (!response.ok) throw new Error(`${modelKey} returned HTTP ${response.status}`);
  if (payload?.setup_required) throw new Error(`${modelKey} read model is not ready`);

  const chunks = splitResponseBody(body);
  if (chunks.length > RESPONSE_MAX_CHUNKS) {
    throw new Error(`${modelKey} response exceeded ${RESPONSE_MAX_CHUNKS} chunks`);
  }
  const generation = `${now}:${modelKey}`;
  const statements = chunks.map((chunk, index) => db.prepare(`INSERT INTO sh_pages_response_chunks(
      model_key,generation,chunk_index,payload_chunk
    ) VALUES(?,?,?,?) ON CONFLICT(model_key,generation,chunk_index) DO UPDATE SET
      payload_chunk=excluded.payload_chunk`)
    .bind(modelKey, generation, index, chunk));
  statements.push(db.prepare(`INSERT INTO sh_pages_response_manifest(
      model_key,generation,status,headers_json,chunk_count,updated_at
    ) VALUES(?,?,?,?,?,?) ON CONFLICT(model_key) DO UPDATE SET
      generation=excluded.generation,status=excluded.status,headers_json=excluded.headers_json,
      chunk_count=excluded.chunk_count,updated_at=excluded.updated_at`)
    .bind(
      modelKey,
      generation,
      response.status,
      JSON.stringify(persistedHeaders(response)),
      chunks.length,
      now,
    ));
  statements.push(db.prepare(`DELETE FROM sh_pages_response_chunks
    WHERE model_key=? AND generation<>?`).bind(modelKey, generation));
  await db.batch(statements);
  return { bytes: body.length, chunks: chunks.length };
}

async function responseHandler(modelKey) {
  if (modelKey.startsWith('playback:')) return (await import('../../site/functions/api/playback.js')).onRequestGet;
  if (modelKey === 'dashboard') return (await import('../../site/functions/api/dashboard.js')).onRequestGet;
  if (modelKey === 'dashboard-history') return (await import('../../site/functions/api/dashboard-history.js')).onRequestGet;
  if (modelKey === 'dashboard-queue') return (await import('../../site/functions/api/dashboard-queue.js')).onRequestGet;
  if (modelKey === 'comment-velocity') return (await import('../../site/functions/api/comment-velocity.js')).onRequestGet;
  if (modelKey === 'track-likes') return (await import('../../site/functions/api/track-likes.js')).onRequestGet;
  if (modelKey === 'like-ranking') return (await import('../../site/functions/api/like-ranking.js')).onRequestGet;
  if (modelKey === 'minute-facts-current') return (await import('../../site/functions/api/minute-facts/current.js')).onRequestGet;
  if (modelKey.startsWith('history:')) return (await import('../../site/functions/api/history.js')).onRequestGet;
  if (modelKey === 'track-history') return (await import('../../site/functions/api/track-history.js')).onRequestGet;
  if (modelKey === 'host-history:summary') return (await import('../../site/functions/api/host-history.js')).onRequestGet;
  throw new Error(`unsupported materialized API model: ${modelKey}`);
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

export async function refreshFastPagesReadModels(env, now = Date.now(), dependencies = {}) {
  const targetDb = env?.MINUTE_DB;
  if (!env?.BUDDIES_DB || !targetDb || !env?.OTHER_DB) {
    return { skipped: true, reason: 'db-binding-missing' };
  }
  await ensureSchema(targetDb);
  const activeEnv = pagesEnvironment(env);
  const [daily, likes] = await Promise.all([
    refreshDailyChanges(targetDb, now),
    refreshLikeRanking(targetDb, now),
  ]);

  const dueVariants = MATERIALIZED_API_VARIANTS.filter((variant) => materializedVariantDue(variant, now));
  const responses = [];
  for (const variant of dueVariants) {
    try {
      const response = await renderVariant(variant, activeEnv, dependencies);
      const saved = await saveResponse(targetDb, variant.key, response, now);
      responses.push({ key: variant.key, ok: true, ...saved });
    } catch (error) {
      responses.push({
        key: variant.key,
        ok: false,
        error: String(error?.message || error).replace(/\s+/g, ' ').trim().slice(0, 500),
      });
    }
  }
  return {
    skipped: false,
    generated_at: now,
    daily,
    likes,
    responses,
    due: dueVariants.length,
    deferred: MATERIALIZED_API_VARIANTS.length - dueVariants.length,
    succeeded: responses.filter((item) => item.ok).length,
    failed: responses.filter((item) => !item.ok).length,
  };
}

async function materializeTrackHistoryRange(sourceDb, targetDb, range, now) {
  const { result, likeRows } = await loadTrackHistoryData(
    sourceDb,
    range.fromTs,
    range.toTs,
    TRACK_HISTORY_LIMIT,
    true,
  );
  const groupedRows = result.results || [];
  if (groupedRows.length > TRACK_HISTORY_LIMIT) {
    throw new Error(`track history read-model range exceeded ${TRACK_HISTORY_LIMIT} grouped rows`);
  }
  const mergedRows = mergeTrackRows(groupedRows);
  const likedRows = attachCompactTrackLikes(mergedRows, likeRows);
  const completed = applyTrackPeriodCompleteness(likedRows, groupedRows);
  const rows = completed.rows;
  const fromDay = dayText(range.fromTs);
  const toDay = dayText(range.toTs - DAY_MS);
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

async function refreshTrackHistory(sourceDb, targetDb, now) {
  const backfillRow = await payloadRow(targetDb, 'track-history-backfill');
  const ranges = trackHistoryRefreshRanges(now, parsedPayload(backfillRow));
  const recent = await materializeTrackHistoryRange(sourceDb, targetDb, ranges.recent, now);
  let backfill = null;
  if (ranges.backfill) {
    backfill = await materializeTrackHistoryRange(sourceDb, targetDb, ranges.backfill, now);
    await savePayload(targetDb, 'track-history-backfill', {
      next_to: ranges.backfill.fromTs,
      completed: ranges.backfill.fromTs <= TRACK_HISTORY_EPOCH,
      updated_at: now,
    }, now);
  } else {
    await savePayload(targetDb, 'track-history-backfill', {
      next_to: TRACK_HISTORY_EPOCH,
      completed: true,
      updated_at: now,
    }, now);
  }

  const coverage = await targetDb.prepare(`SELECT MIN(play_date) AS earliest_date,MAX(play_date) AS latest_date
    FROM sh_pages_track_history_read_model`).first();
  await savePayload(targetDb, 'track-history-status', {
    ok: true,
    from: coverage?.earliest_date || recent.from,
    to: coverage?.latest_date || recent.to,
    row_count: recent.rows,
    source_row_count: recent.sourceRowCount,
    source_truncated: false,
    excluded_play_count_dates: recent.excludedDates,
    grace_ms: TRACK_HISTORY_GRACE_MS,
    backfill_completed: !ranges.backfill || ranges.backfill.fromTs <= TRACK_HISTORY_EPOCH,
    backfill_from: backfill?.from || null,
    backfill_to: backfill?.to || null,
    generated_at: now,
  }, now);
  return { recent, backfill };
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
