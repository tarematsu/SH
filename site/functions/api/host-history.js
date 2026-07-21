function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=30, s-maxage=60, stale-while-revalidate=300',
    },
  });
}

function intParam(value, fallback, min, max) {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export const HOST_SUMMARY_SQL = `WITH active_session AS (
  SELECT id,handle,station_id,started_at,confirmed_at,ended_at,status,
    peak_listeners,average_listeners,total_listens_start,total_listens_end,
    listener_sample_count,track_count,comment_count,last_observed_at
  FROM sh_host_broadcast_sessions
  WHERE handle='sakurazaka46jp' AND status IN ('provisional','active')
  ORDER BY started_at DESC
  LIMIT 1
), recent_sessions AS (
  SELECT id,handle,station_id,started_at,confirmed_at,ended_at,status,
    peak_listeners,average_listeners,total_listens_start,total_listens_end,
    listener_sample_count,track_count,comment_count,last_observed_at
  FROM sh_host_broadcast_sessions
  WHERE handle='sakurazaka46jp'
  ORDER BY started_at DESC
  LIMIT 10
)
SELECT 1 AS result_kind,id,handle,station_id,started_at,confirmed_at,ended_at,status,
  peak_listeners,average_listeners,total_listens_start,total_listens_end,
  listener_sample_count,track_count,comment_count,last_observed_at
FROM active_session
UNION ALL
SELECT 2,id,handle,station_id,started_at,confirmed_at,ended_at,status,
  peak_listeners,average_listeners,total_listens_start,total_listens_end,
  listener_sample_count,track_count,comment_count,last_observed_at
FROM recent_sessions
ORDER BY result_kind ASC,started_at DESC`;

function activeSessionFromRow(row) {
  return {
    id: row.id,
    handle: row.handle,
    station_id: row.station_id,
    started_at: row.started_at,
    confirmed_at: row.confirmed_at,
    status: row.status,
    peak_listeners: row.peak_listeners,
    listener_sample_count: row.listener_sample_count,
    track_count: row.track_count,
    comment_count: row.comment_count,
    last_observed_at: row.last_observed_at,
  };
}

function recentSessionFromRow(row) {
  return {
    id: row.id,
    handle: row.handle,
    station_id: row.station_id,
    started_at: row.started_at,
    ended_at: row.ended_at,
    status: row.status,
    peak_listeners: row.peak_listeners,
    average_listeners: row.average_listeners,
    total_listens_start: row.total_listens_start,
    total_listens_end: row.total_listens_end,
    track_count: row.track_count,
    comment_count: row.comment_count,
  };
}

export function parseHostSummaryRows(rows = []) {
  let activeSession = null;
  const recentSessions = [];
  for (const row of rows) {
    const kind = Number(row?.result_kind);
    if (kind === 1 && !activeSession) activeSession = activeSessionFromRow(row);
    else if (kind === 2) recentSessions.push(recentSessionFromRow(row));
  }
  return { activeSession, recentSessions };
}

const SUMMARY_CACHE_MS = 30 * 1000;
let summaryStates = new WeakMap();

function summaryStateFor(db) {
  let state = summaryStates.get(db);
  if (!state) {
    state = { value: null, hasValue: false, expiresAt: 0, pending: null };
    summaryStates.set(db, state);
  }
  return state;
}

export async function loadHostSummary(db) {
  const result = await db.prepare(HOST_SUMMARY_SQL).all();
  return parseHostSummaryRows(result?.results || []);
}

export async function cachedHostSummary(db, now = Date.now()) {
  const state = summaryStateFor(db);
  if (state.hasValue && state.expiresAt > now) return state.value;
  if (state.pending) return state.pending;

  state.pending = loadHostSummary(db).then((value) => {
    state.value = value;
    state.hasValue = true;
    state.expiresAt = Date.now() + SUMMARY_CACHE_MS;
    return value;
  }).catch((error) => {
    state.hasValue = false;
    state.value = null;
    state.expiresAt = 0;
    throw error;
  }).finally(() => {
    state.pending = null;
  });
  return state.pending;
}

export function resetHostSummaryCache(db = null) {
  if (db) summaryStates.delete(db);
  else summaryStates = new WeakMap();
}

export async function onRequestGet({ request, env }) {
  if (!env.OTHER_DB) return json({ ok: false, error: 'OTHER_DB binding missing' }, 500);
  const url = new URL(request.url);
  const mode = url.searchParams.get('mode') || 'summary';

  try {
    if (mode === 'profile') {
      return json({ ok: false, error: 'general profile history retired' }, 404);
    }

    if (mode === 'sessions') {
      const handle = url.searchParams.get('handle') || 'sakurazaka46jp';
      const limit = intParam(url.searchParams.get('limit'), 50, 1, 500);
      const result = await env.OTHER_DB.prepare(`
        SELECT id, source_scope, handle, account_id, station_id, broadcast_id,
               started_at, confirmed_at, ended_at, status, detection_reason,
               end_reason, peak_listeners, average_listeners,
               total_listens_start, total_listens_end,
               followers_start, followers_end, total_streams_start, total_streams_end,
               track_count, comment_count, last_observed_at
        FROM sh_host_broadcast_sessions
        WHERE handle = ?
        ORDER BY started_at DESC
        LIMIT ?
      `).bind(handle, limit).all();
      return json({ ok: true, mode, handle, rows: result.results || [] });
    }

    if (mode === 'session') {
      const sessionId = intParam(url.searchParams.get('id'), 0, 1, Number.MAX_SAFE_INTEGER);
      if (!sessionId) return json({ ok: false, error: 'id is required' }, 400);
      const [sessionResult, snapshots, queues, tracks] = await env.OTHER_DB.batch([
        env.OTHER_DB.prepare(`SELECT
          id,source_scope,handle,account_id,station_id,broadcast_id,broadcast_stream_id,
          started_at,confirmed_at,ended_at,status,detection_reason,end_reason,
          buddies_station_id,channel_id,channel_alias,total_listens_start,total_listens_end,
          followers_start,followers_end,total_streams_start,total_streams_end,
          peak_listeners,listener_sum,listener_sample_count,average_listeners,
          track_count,comment_count,last_observed_at
          FROM sh_host_broadcast_sessions WHERE id=? LIMIT 1`).bind(sessionId),
        env.OTHER_DB.prepare(`SELECT observed_at,listener_count,guest_count,total_listens,
          is_broadcasting,current_track_id,current_spotify_id,queue_id,queue_start_time
          FROM sh_host_station_snapshots
          WHERE session_id=? ORDER BY observed_at ASC LIMIT 10000`).bind(sessionId),
        env.OTHER_DB.prepare(`SELECT id,observed_at,queue_id,queue_start_time,is_paused,
          queue_hash,current_track_id,current_spotify_id
          FROM sh_host_queue_snapshots
          WHERE session_id=? ORDER BY observed_at ASC LIMIT 1000`).bind(sessionId),
        env.OTHER_DB.prepare(`SELECT observed_at,queue_start_time,position,queue_track_id,
          stationhead_track_id,spotify_id,deezer_id,
          isrc,duration_ms,preview_url,bite_count
          FROM sh_host_queue_items
          WHERE session_id=? ORDER BY queue_start_time ASC,position ASC LIMIT 10000`).bind(sessionId),
      ]);
      const session = sessionResult.results?.[0] || null;
      if (!session) return json({ ok: false, error: 'session not found' }, 404);

      return json({
        ok: true,
        mode,
        session,
        snapshots: snapshots.results || [],
        queues: queues.results || [],
        tracks: tracks.results || [],
      });
    }

    if (mode !== 'summary') return json({ ok: false, error: `unsupported mode: ${mode}` }, 400);
    const summary = await cachedHostSummary(env.OTHER_DB);
    return json({
      ok: true,
      mode: 'summary',
      sakurazaka46jp_active_session: summary.activeSession,
      sakurazaka46jp_recent_sessions: summary.recentSessions,
    });
  } catch (error) {
    console.error(error);
    return json({ ok: false, error: error?.message || 'database error' }, 500);
  }
}
