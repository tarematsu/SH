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

const LATEST_PROFILE_SQL = `SELECT observed_at, handle, account_id, followers, following,
       total_streams, active_stream_days, thumbnail_url
FROM sh_host_profile_snapshots
WHERE handle = 'sakuramankai'
ORDER BY observed_at DESC LIMIT 1`;

const ACTIVE_SESSION_SQL = `SELECT id, handle, station_id, started_at, confirmed_at, status,
       peak_listeners, listener_sample_count, track_count, comment_count,
       last_observed_at
FROM sh_host_broadcast_sessions
WHERE handle = 'sakurazaka46jp' AND status IN ('provisional', 'active')
ORDER BY started_at DESC LIMIT 1`;

const RECENT_SESSIONS_SQL = `SELECT id, handle, station_id, started_at, ended_at, status,
       peak_listeners, average_listeners, total_listens_start,
       total_listens_end, track_count, comment_count
FROM sh_host_broadcast_sessions
WHERE handle = 'sakurazaka46jp'
ORDER BY started_at DESC LIMIT 10`;

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
  if (typeof db.batch === 'function') {
    const [latestProfileResult, activeSessionResult, recentSessionsResult] = await db.batch([
      db.prepare(LATEST_PROFILE_SQL),
      db.prepare(ACTIVE_SESSION_SQL),
      db.prepare(RECENT_SESSIONS_SQL),
    ]);
    return {
      latestProfile: latestProfileResult?.results?.[0] || null,
      activeSession: activeSessionResult?.results?.[0] || null,
      recentSessions: recentSessionsResult?.results || [],
    };
  }

  const [latestProfile, activeSession, recentSessions] = await Promise.all([
    db.prepare(LATEST_PROFILE_SQL).first(),
    db.prepare(ACTIVE_SESSION_SQL).first(),
    db.prepare(RECENT_SESSIONS_SQL).all(),
  ]);
  return {
    latestProfile: latestProfile || null,
    activeSession: activeSession || null,
    recentSessions: recentSessions.results || [],
  };
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
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500);
  const url = new URL(request.url);
  const mode = url.searchParams.get('mode') || 'summary';

  try {
    if (mode === 'profile') {
      const handle = url.searchParams.get('handle') || 'sakuramankai';
      const days = intParam(url.searchParams.get('days'), 365, 1, 3650);
      const limit = intParam(url.searchParams.get('limit'), 1000, 1, 5000);
      const since = Date.now() - days * 86400000;
      const result = await env.DB.prepare(`
        SELECT observed_at, handle, account_id, followers, following,
               total_streams, active_stream_days, thumbnail_url
        FROM (
          SELECT observed_at, handle, account_id, followers, following,
                 total_streams, active_stream_days, thumbnail_url
          FROM sh_host_profile_snapshots
          WHERE handle = ? AND observed_at >= ?
          ORDER BY observed_at DESC
          LIMIT ?
        )
        ORDER BY observed_at ASC
      `).bind(handle, since, limit).all();
      return json({ ok: true, mode, handle, rows: result.results || [] });
    }

    if (mode === 'sessions') {
      const handle = url.searchParams.get('handle') || 'sakurazaka46jp';
      const limit = intParam(url.searchParams.get('limit'), 50, 1, 500);
      const result = await env.DB.prepare(`
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
      const [sessionResult, snapshots, queues, tracks, comments, events] = await env.DB.batch([
        env.DB.prepare(`SELECT
          id,source_scope,handle,account_id,station_id,broadcast_id,broadcast_stream_id,
          started_at,confirmed_at,ended_at,status,detection_reason,end_reason,
          buddies_station_id,channel_id,channel_alias,total_listens_start,total_listens_end,
          followers_start,followers_end,total_streams_start,total_streams_end,
          peak_listeners,listener_sum,listener_sample_count,average_listeners,
          track_count,comment_count,last_observed_at,raw_start_json,raw_end_json
          FROM sh_host_broadcast_sessions WHERE id=? LIMIT 1`).bind(sessionId),
        env.DB.prepare(`SELECT observed_at,listener_count,guest_count,total_listens,
          is_broadcasting,current_track_id,current_spotify_id,queue_id,queue_start_time
          FROM sh_host_station_snapshots
          WHERE session_id=? ORDER BY observed_at ASC LIMIT 10000`).bind(sessionId),
        env.DB.prepare(`SELECT id,observed_at,queue_id,queue_start_time,is_paused,
          queue_hash,current_track_id,current_spotify_id
          FROM sh_host_queue_snapshots
          WHERE session_id=? ORDER BY observed_at ASC LIMIT 1000`).bind(sessionId),
        env.DB.prepare(`SELECT observed_at,queue_start_time,position,queue_track_id,
          stationhead_track_id,spotify_id,apple_music_id,deezer_id,
          isrc,duration_ms,preview_url,bite_count
          FROM sh_host_queue_items
          WHERE session_id=? ORDER BY queue_start_time ASC,position ASC LIMIT 10000`).bind(sessionId),
        env.DB.prepare(`SELECT comment_id,observed_at,account_id,handle,text,
          chat_time,chat_time_ms,followers,active_stream_days,emoji
          FROM sh_host_comments
          WHERE session_id=? ORDER BY COALESCE(chat_time_ms,observed_at) ASC LIMIT 10000`).bind(sessionId),
        env.DB.prepare(`SELECT observed_at,channel,event,data_json
          FROM sh_host_raw_events
          WHERE session_id=? ORDER BY observed_at ASC LIMIT 10000`).bind(sessionId),
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
        comments: comments.results || [],
        events: events.results || [],
      });
    }

    const summary = await cachedHostSummary(env.DB);
    return json({
      ok: true,
      mode: 'summary',
      sakuramankai: summary.latestProfile,
      sakurazaka46jp_active_session: summary.activeSession,
      sakurazaka46jp_recent_sessions: summary.recentSessions,
    });
  } catch (error) {
    console.error(error);
    return json({ ok: false, error: error?.message || 'database error' }, 500);
  }
}
