import { sanitizeFailureDetail } from './collector-failure.js';

const DEFAULT_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 500;
const DEFAULT_SOURCE_LAG_MS = 5 * 60_000;
const SYNC_KEYS = Object.freeze(['queue-items', 'track-likes', 'track-metadata']);

function integer(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function text(value) {
  if (value == null || value === '') return null;
  const result = String(value).trim();
  return result || null;
}

function positive(value, fallback, maximum) {
  const parsed = integer(value);
  if (parsed == null || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

function sourceCutoff(now, env) {
  const configured = integer(env?.BUDDIES_SYNC_SOURCE_LAG_MS);
  const lag = configured == null || configured < 0
    ? DEFAULT_SOURCE_LAG_MS
    : configured;
  return now - lag;
}

function cursor(state) {
  return {
    observedAt: integer(state?.cursor_observed_at) || 0,
    sourceId: integer(state?.cursor_source_id) || 0,
    sourceText: text(state?.cursor_source_text) || '',
  };
}

async function loadState(db, syncKey) {
  return db.prepare('SELECT * FROM sh_buddies_sync_state WHERE sync_key=?')
    .bind(syncKey).first();
}

async function saveState(db, syncKey, values = {}) {
  await db.prepare(`UPDATE sh_buddies_sync_state SET
      cursor_observed_at=?,cursor_source_id=?,cursor_source_text=?,
      rows_processed=rows_processed+?,last_run_at=?,last_success_at=?,last_error=?,updated_at=?
    WHERE sync_key=?`).bind(
    integer(values.cursorObservedAt) || 0,
    integer(values.cursorSourceId) || 0,
    text(values.cursorSourceText),
    integer(values.rowsProcessed) || 0,
    values.lastRunAt ?? Date.now(),
    values.lastSuccessAt ?? Date.now(),
    values.lastError ?? null,
    Date.now(),
    syncKey,
  ).run();
}

function queueItemStatement(db, row) {
  return db.prepare(`INSERT INTO sh_queue_item_observations(
      source_id,observed_at,station_id,queue_id,start_time,position,
      queue_track_id,stationhead_track_id,spotify_id,apple_music_id,deezer_id,
      isrc,duration_ms,preview_url,bite_count
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(source_id) DO UPDATE SET
      observed_at=excluded.observed_at,station_id=excluded.station_id,
      queue_id=excluded.queue_id,start_time=excluded.start_time,
      position=excluded.position,queue_track_id=excluded.queue_track_id,
      stationhead_track_id=excluded.stationhead_track_id,spotify_id=excluded.spotify_id,
      apple_music_id=excluded.apple_music_id,deezer_id=excluded.deezer_id,
      isrc=excluded.isrc,duration_ms=excluded.duration_ms,
      preview_url=excluded.preview_url,bite_count=excluded.bite_count`).bind(
    integer(row.id), integer(row.observed_at), integer(row.station_id), integer(row.queue_id),
    integer(row.start_time), integer(row.position), integer(row.queue_track_id),
    integer(row.stationhead_track_id), text(row.spotify_id), text(row.apple_music_id),
    text(row.deezer_id), text(row.isrc), integer(row.duration_ms), text(row.preview_url),
    integer(row.bite_count),
  );
}

function likeStatement(db, row) {
  return db.prepare(`INSERT INTO sh_track_like_observations(
      source_id,observed_at,station_id,queue_id,start_time,position,
      queue_track_id,stationhead_track_id,spotify_id,apple_music_id,isrc,
      track_key,like_count,source
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(source_id) DO UPDATE SET
      observed_at=excluded.observed_at,station_id=excluded.station_id,
      queue_id=excluded.queue_id,start_time=excluded.start_time,
      position=excluded.position,queue_track_id=excluded.queue_track_id,
      stationhead_track_id=excluded.stationhead_track_id,spotify_id=excluded.spotify_id,
      apple_music_id=excluded.apple_music_id,isrc=excluded.isrc,
      track_key=excluded.track_key,like_count=excluded.like_count,
      source=excluded.source`).bind(
    integer(row.id), integer(row.observed_at), integer(row.station_id), integer(row.queue_id),
    integer(row.start_time), integer(row.position), integer(row.queue_track_id),
    integer(row.stationhead_track_id), text(row.spotify_id), text(row.apple_music_id),
    text(row.isrc), text(row.track_key), integer(row.like_count), text(row.source) || 'buddies-buffer',
  );
}

function metadataStatement(db, row) {
  const spotifyId = text(row.spotify_id);
  return db.prepare(`INSERT INTO sh_track_metadata(
      spotify_id,title,artist,display_title,thumbnail_url,spotify_url,source,fetched_at,raw_json
    ) VALUES(?,?,?,?,?,?,?,?,?)
    ON CONFLICT(spotify_id) DO UPDATE SET
      title=COALESCE(excluded.title,sh_track_metadata.title),
      artist=COALESCE(excluded.artist,sh_track_metadata.artist),
      display_title=COALESCE(excluded.display_title,sh_track_metadata.display_title),
      thumbnail_url=COALESCE(excluded.thumbnail_url,sh_track_metadata.thumbnail_url),
      spotify_url=COALESCE(excluded.spotify_url,sh_track_metadata.spotify_url),
      source=excluded.source,fetched_at=MAX(excluded.fetched_at,sh_track_metadata.fetched_at),
      raw_json=COALESCE(excluded.raw_json,sh_track_metadata.raw_json)`).bind(
    spotifyId, text(row.title), text(row.artist), text(row.display_title), text(row.thumbnail_url),
    text(row.spotify_url), text(row.source) || 'buddies-buffer', integer(row.fetched_at), text(row.raw_json),
  );
}

async function readRows(sourceDb, syncKey, state, cutoff, limit) {
  const current = cursor(state);
  if (syncKey === 'track-metadata') {
    return sourceDb.prepare(`SELECT spotify_id,title,artist,display_title,thumbnail_url,
        spotify_url,source,fetched_at,raw_json
      FROM sh_track_metadata WHERE fetched_at<? AND (
        fetched_at>? OR (fetched_at=? AND spotify_id>?)
      ) ORDER BY fetched_at ASC,spotify_id ASC LIMIT ?`)
      .bind(cutoff, current.observedAt, current.observedAt, current.sourceText, limit).all();
  }
  const table = syncKey === 'queue-items' ? 'sh_queue_items' : 'sh_track_like_observations';
  return sourceDb.prepare(`SELECT * FROM ${table}
    WHERE observed_at<? AND (observed_at>? OR (observed_at=? AND id>?))
    ORDER BY observed_at ASC,id ASC LIMIT ?`)
    .bind(cutoff, current.observedAt, current.observedAt, current.sourceId, limit).all();
}

async function syncOne(env, syncKey, now, limit) {
  const sourceDb = env?.DB || env?.BUDDIES_DB;
  const factsDb = env?.FACTS_DB;
  if (!sourceDb || !factsDb) return { syncKey, skipped: true, reason: 'db-binding-missing' };
  const state = await loadState(factsDb, syncKey);
  if (!state) return { syncKey, skipped: true, reason: 'state-missing' };
  const result = await readRows(sourceDb, syncKey, state, sourceCutoff(now, env), limit);
  const rows = result.results || [];
  if (!rows.length) {
    await factsDb.prepare(`UPDATE sh_buddies_sync_state SET
        last_run_at=?,last_success_at=?,last_error=NULL,updated_at=? WHERE sync_key=?`)
      .bind(now, now, now, syncKey).run();
    return { syncKey, skipped: false, rows: 0, caught_up: true };
  }
  const statements = rows.map((row) => syncKey === 'queue-items'
    ? queueItemStatement(factsDb, row)
    : syncKey === 'track-likes'
      ? likeStatement(factsDb, row)
      : metadataStatement(factsDb, row));
  await factsDb.batch(statements);
  const last = rows.at(-1);
  const lastAt = integer(last.observed_at ?? last.fetched_at) || 0;
  const lastId = integer(last.id) || 0;
  const lastText = text(last.spotify_id);
  await saveState(factsDb, syncKey, {
    cursorObservedAt: lastAt,
    cursorSourceId: lastId,
    cursorSourceText: lastText,
    rowsProcessed: rows.length,
    lastRunAt: now,
    lastSuccessAt: now,
  });
  return { syncKey, skipped: false, rows: rows.length, caught_up: rows.length < limit };
}

export async function runBuddiesFactsSync(env, options = {}) {
  const now = integer(options.now) || Date.now();
  const limit = positive(options.limit ?? env?.BUDDIES_SYNC_BATCH_SIZE, DEFAULT_BATCH_SIZE, MAX_BATCH_SIZE);
  const results = [];
  for (const syncKey of SYNC_KEYS) {
    try {
      results.push(await syncOne(env, syncKey, now, limit));
    } catch (error) {
      const detail = sanitizeFailureDetail(error?.message || error);
      if (env?.FACTS_DB) {
        await env.FACTS_DB.prepare(`UPDATE sh_buddies_sync_state SET
            last_run_at=?,last_error=?,updated_at=? WHERE sync_key=?`)
          .bind(now, detail.slice(0, 800), now, syncKey).run().catch(() => {});
      }
      results.push({ syncKey, skipped: true, reason: 'sync-error', error: detail });
    }
  }
  return {
    skipped: results.every((result) => result.skipped && result.reason === 'db-binding-missing'),
    failed: results.some((result) => result.reason === 'sync-error'),
    error: results.find((result) => result.reason === 'sync-error')?.error || null,
    results,
    rows: results.reduce((sum, result) => sum + Number(result.rows || 0), 0),
  };
}
