import {
  FACT_QUALITY_FLAGS,
  MINUTE_FACT_SOURCE_CODES,
  minuteBucket,
  minuteFactStatement,
  resolveHost,
  resolveTrack,
} from './minute-facts-store.js';

const MIGRATION_KEY = 'legacy-minute-facts-v1';
const DEFAULT_BATCH_SIZE = 250;
const SESSION_GAP_MS = 6 * 60 * 60_000;

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function integer(value) {
  const parsed = num(value);
  return parsed == null ? null : Math.trunc(parsed);
}

function text(value) {
  if (value === null || value === undefined) return null;
  const parsed = String(value).trim();
  return parsed || null;
}

function normalized(value) {
  return text(value)?.toLowerCase() || null;
}

function chunks(values, size = 35) {
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

async function runBatches(db, statements) {
  for (const group of chunks(statements)) {
    if (group.length) await db.batch(group);
  }
}

async function loadState(db) {
  await db.prepare(`INSERT OR IGNORE INTO sh_migration_state(
      migration_key,phase,cursor_observed_at,cursor_source_id,migrated_rows,error_rows,updated_at
    ) VALUES(?,'legacy_normalized',0,0,0,0,?)`).bind(MIGRATION_KEY, Date.now()).run();
  return db.prepare('SELECT * FROM sh_migration_state WHERE migration_key=?')
    .bind(MIGRATION_KEY).first();
}

async function discoverChannelId(oldDb, env) {
  const configured = integer(env?.CHANNEL_ID ?? env?.BUDDIES_CHANNEL_ID);
  if (configured != null) return configured;
  const row = await oldDb.prepare(`SELECT channel_id FROM sh_channel_snapshots
    WHERE channel_id IS NOT NULL ORDER BY observed_at DESC,id DESC LIMIT 1`).first();
  return integer(row?.channel_id);
}

function normalizedRowsSql() {
  return `SELECT
      s.legacy_id AS source_id,s.observed_at,s.listener_count,s.total_stream_count,
      s.likes,s.total_member_count,s.quality_score,s.quality_flags,
      t.id AS legacy_track_id,t.title AS track_title,t.artist_name,
      h.id AS legacy_host_id,h.handle AS host_handle,
      b.id AS legacy_broadcast_id,b.event_name
    FROM sh_legacy_samples s
    LEFT JOIN sh_legacy_tracks t ON t.id=s.track_id
    LEFT JOIN sh_legacy_hosts h ON h.id=s.host_id
    LEFT JOIN sh_legacy_broadcasts b ON b.id=s.broadcast_id
    WHERE s.observed_at>? OR (s.observed_at=? AND s.legacy_id>?)
    ORDER BY s.observed_at ASC,s.legacy_id ASC LIMIT ?`;
}

function rawRowsSql() {
  return `SELECT
      l.id AS source_id,l.observed_at,l.listener_count,l.total_stream_count,
      l.likes,l.total_member_count,l.quality_score,l.quality_flags,
      NULL AS legacy_track_id,l.track_title,l.artist_name,
      NULL AS legacy_host_id,l.host_handle,
      NULL AS legacy_broadcast_id,l.source_note AS event_name
    FROM sh_legacy_snapshots l
    WHERE NOT EXISTS(SELECT 1 FROM sh_legacy_samples s WHERE s.legacy_id=l.id)
      AND (l.observed_at>? OR (l.observed_at=? AND l.id>?))
    ORDER BY l.observed_at ASC,l.id ASC LIMIT ?`;
}

async function loadRows(oldDb, state, limit) {
  const phase = String(state.phase || 'legacy_normalized');
  const sql = phase === 'legacy_raw' ? rawRowsSql() : normalizedRowsSql();
  const cursorAt = integer(state.cursor_observed_at) || 0;
  return oldDb.prepare(sql).bind(
    cursorAt,
    cursorAt,
    integer(state.cursor_source_id) || 0,
    limit,
  ).all().then((result) => result.results || []);
}

function broadcastKey(row) {
  if (row.legacy_broadcast_id != null) return `legacy_broadcast_id:${row.legacy_broadcast_id}`;
  const event = normalized(row.event_name) || '';
  const host = normalized(row.host_handle) || '';
  return event || host ? `legacy_name:${event}\u001f${host}` : 'legacy_unspecified';
}

async function resolveLegacySession(db, state, input) {
  const { channelId, hostId, row, source, observedAt } = input;
  const nextBroadcastKey = broadcastKey(row);
  const activeSessionId = integer(state.active_session_id);
  const sameSession = activeSessionId != null
    && String(state.active_broadcast_key || '') === nextBroadcastKey
    && Number(state.active_host_id || 0) === Number(hostId || 0)
    && observedAt - Number(state.active_last_observed_at || 0) <= SESSION_GAP_MS;

  if (sameSession) {
    state.active_last_observed_at = observedAt;
    return activeSessionId;
  }

  if (activeSessionId != null) {
    const endedAt = integer(state.active_last_observed_at) || observedAt;
    await db.prepare(`UPDATE sh_broadcast_sessions SET
        last_observed_at=MAX(last_observed_at,?),ended_at=COALESCE(ended_at,?),status='ended'
      WHERE id=?`).bind(endedAt, endedAt, activeSessionId).run();
  }

  const sessionKey = `${source}:${channelId}:${nextBroadcastKey}:${hostId || 0}:${observedAt}`;
  await db.prepare(`INSERT OR IGNORE INTO sh_broadcast_sessions(
      session_key,channel_id,station_id,host_id,broadcast_start_time,
      first_observed_at,last_observed_at,ended_at,status,source
    ) VALUES(?,?,NULL,?,NULL,?,?,NULL,'active',?)`).bind(
      sessionKey, channelId, hostId, observedAt, observedAt, source,
    ).run();
  const session = await db.prepare('SELECT id FROM sh_broadcast_sessions WHERE session_key=?')
    .bind(sessionKey).first();
  const sessionId = integer(session?.id);
  state.active_session_id = sessionId;
  state.active_session_key = sessionKey;
  state.active_host_id = hostId;
  state.active_broadcast_key = nextBroadcastKey;
  state.active_last_observed_at = observedAt;
  return sessionId;
}

async function closeActiveSession(db, state) {
  const sessionId = integer(state.active_session_id);
  if (sessionId != null) {
    const endedAt = integer(state.active_last_observed_at) || Date.now();
    await db.prepare(`UPDATE sh_broadcast_sessions SET
      last_observed_at=MAX(last_observed_at,?),ended_at=COALESCE(ended_at,?),status='ended'
      WHERE id=?`).bind(endedAt, endedAt, sessionId).run();
  }
  state.active_session_id = null;
  state.active_session_key = null;
  state.active_host_id = null;
  state.active_broadcast_key = null;
  state.active_last_observed_at = null;
}

export function legacyFact({ row, channelId, hostId, trackId, sessionId, source, sourcePriority }) {
  const observedAt = integer(row.observed_at);
  const score = Math.max(0, Math.min(1, num(row.quality_score) ?? 1));
  return {
    channel_id: channelId,
    station_id: null,
    minute_at: minuteBucket(observedAt),
    observed_at: observedAt,
    received_at: Date.now(),
    source_code: MINUTE_FACT_SOURCE_CODES[source],
    source_priority: sourcePriority,
    source_record_id: String(row.source_id),
    collector_id: 'legacy-migration',
    broadcast_session_id: sessionId,
    host_id: hostId,
    is_broadcasting: 1,
    broadcast_start_time: null,
    listener_count: integer(row.listener_count),
    online_member_count: null,
    total_member_count: integer(row.total_member_count),
    guest_count: null,
    reported_total_listens: integer(row.total_stream_count),
    reported_current_stream_count: null,
    validated_stream_count: null,
    stream_count_rejected: 0,
    queue_revision_id: null,
    queue_id: null,
    queue_start_time: null,
    is_paused: 0,
    queue_track_count: null,
    queue_available: 0,
    track_id: trackId,
    queue_position: null,
    // Legacy observations have no queue evidence, so they cannot use either
    // queue-derived detection code even when a catalog track was resolved.
    track_detection_code: 0,
    track_confidence: trackId == null ? 0 : 1,
    schedule_valid: trackId == null ? 0 : 1,
    track_bite_count: integer(row.likes),
    comment_count: null,
    comment_total: null,
    comments_degraded: 0,
    quality_score: score,
    quality_flags: score < 1 ? FACT_QUALITY_FLAGS.LEGACY_QUALITY_REDUCED : 0,
  };
}

async function persistState(db, state, updates = {}) {
  const merged = { ...state, ...updates };
  await db.prepare(`UPDATE sh_migration_state SET
      phase=?,cursor_observed_at=?,cursor_source_id=?,migrated_rows=?,error_rows=?,
      active_session_id=?,active_session_key=?,active_host_id=?,active_broadcast_key=?,
      active_last_observed_at=?,last_error=?,metadata_json=?,updated_at=?
    WHERE migration_key=?`).bind(
      merged.phase,
      integer(merged.cursor_observed_at) || 0,
      integer(merged.cursor_source_id) || 0,
      integer(merged.migrated_rows) || 0,
      integer(merged.error_rows) || 0,
      integer(merged.active_session_id),
      text(merged.active_session_key),
      integer(merged.active_host_id),
      text(merged.active_broadcast_key),
      integer(merged.active_last_observed_at),
      text(merged.last_error),
      text(merged.metadata_json),
      Date.now(),
      MIGRATION_KEY,
    ).run();
}

export async function runMinuteFactsLegacyBackfill(env, options = {}) {
  const oldDb = env?.DB;
  const factsDb = env?.FACTS_DB;
  if (!oldDb) return { skipped: true, reason: 'legacy-db-binding-missing' };
  if (!factsDb) return { skipped: true, reason: 'facts-db-binding-missing' };
  const limit = Math.max(20, Math.min(
    1000,
    integer(options.batchSize ?? env.MINUTE_FACTS_BACKFILL_BATCH) || DEFAULT_BATCH_SIZE,
  ));
  const channelId = await discoverChannelId(oldDb, env);
  if (channelId == null) return { skipped: true, reason: 'channel-id-missing' };

  const state = await loadState(factsDb);
  if (state.phase === 'complete') {
    return { skipped: true, reason: 'complete', migrated: Number(state.migrated_rows || 0) };
  }

  try {
    const rows = await loadRows(oldDb, state, limit);
    if (!rows.length) {
      await closeActiveSession(factsDb, state);
      if (state.phase === 'legacy_normalized') {
        await persistState(factsDb, state, {
          phase: 'legacy_raw',
          cursor_observed_at: 0,
          cursor_source_id: 0,
          last_error: null,
        });
        return { skipped: false, phase: 'legacy_normalized', migrated: 0, nextPhase: 'legacy_raw' };
      }
      await persistState(factsDb, state, { phase: 'complete', last_error: null });
      return { skipped: false, phase: 'complete', migrated: 0, complete: true };
    }

    const source = state.phase === 'legacy_raw' ? 'legacy_raw' : 'legacy_normalized';
    const sourcePriority = source === 'legacy_normalized' ? 80 : 70;
    const hostCache = new Map();
    const trackCache = new Map();
    const statements = [];

    for (const row of rows) {
      const observedAt = integer(row.observed_at);
      const hostCacheKey = `${row.legacy_host_id ?? ''}:${normalized(row.host_handle) ?? ''}`;
      let hostId = hostCache.get(hostCacheKey);
      if (hostId === undefined) {
        hostId = await resolveHost(factsDb, {
          legacyId: row.legacy_host_id,
          handle: row.host_handle,
        }, observedAt);
        hostCache.set(hostCacheKey, hostId);
      }

      const trackCacheKey = `${row.legacy_track_id ?? ''}:${normalized(row.track_title) ?? ''}:${normalized(row.artist_name) ?? ''}`;
      let trackId = trackCache.get(trackCacheKey);
      if (trackId === undefined) {
        trackId = await resolveTrack(factsDb, {
          legacyId: row.legacy_track_id,
          title: row.track_title,
          artist: row.artist_name,
        }, observedAt);
        trackCache.set(trackCacheKey, trackId);
      }

      const sessionId = await resolveLegacySession(factsDb, state, {
        channelId, hostId, row, source, observedAt,
      });
      statements.push(minuteFactStatement(factsDb, legacyFact({
        row, channelId, hostId, trackId, sessionId, source, sourcePriority,
      })));
      state.cursor_observed_at = observedAt;
      state.cursor_source_id = integer(row.source_id);
    }

    await runBatches(factsDb, statements);
    if (state.active_session_id != null) {
      await factsDb.prepare(`UPDATE sh_broadcast_sessions SET last_observed_at=MAX(last_observed_at,?)
        WHERE id=?`).bind(state.active_last_observed_at, state.active_session_id).run();
    }
    const migratedRows = Number(state.migrated_rows || 0) + rows.length;
    await persistState(factsDb, state, { migrated_rows: migratedRows, last_error: null });
    return {
      skipped: false,
      phase: source,
      migrated: rows.length,
      migratedTotal: migratedRows,
      cursorObservedAt: state.cursor_observed_at,
      cursorSourceId: state.cursor_source_id,
    };
  } catch (error) {
    const errorRows = Number(state.error_rows || 0) + 1;
    await persistState(factsDb, state, {
      error_rows: errorRows,
      last_error: String(error?.message || error).slice(0, 1000),
    }).catch(() => {});
    throw error;
  }
}
