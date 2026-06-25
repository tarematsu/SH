const safeJson = (value, fallback = null) => {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
};

const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const json = (data, status = 200, cache = 'public, max-age=20, s-maxage=30, stale-while-revalidate=90') =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': cache,
      'vary': 'accept-encoding',
    },
  });

function jstDayRange(now = Date.now(), cutoffHour = 0) {
  const shifted = new Date(now + 9 * 3600000);
  let currentStart = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
    cutoffHour,
  ) - 9 * 3600000;
  if (now < currentStart) currentStart -= 86400000;
  return { previousStart: currentStart - 86400000, currentStart };
}

export function hostScopeFromSnapshot(snapshot) {
  const hostAccountIdRaw = snapshot?.host_account_id;
  const hostAccountId = hostAccountIdRaw === undefined || hostAccountIdRaw === null || hostAccountIdRaw === ''
    ? null
    : Number(hostAccountIdRaw);
  if (Number.isFinite(hostAccountId) && hostAccountId > 0) {
    return { column: 'host_account_id', value: hostAccountId };
  }

  const hostHandle = String(snapshot?.host_handle || '').trim();
  if (hostHandle) {
    return { column: 'host_handle', value: hostHandle };
  }

  return null;
}

function hostScopedLatestSql(metricColumn, hostScope) {
  const hostClause = hostScope ? ` AND ${hostScope.column} = ?` : '';
  return `SELECT observed_at,${metricColumn}
FROM sh_channel_snapshots
WHERE observed_at>=? AND observed_at<?${hostClause}
ORDER BY observed_at DESC,id DESC LIMIT 1`;
}

function hostScopedBinds(hostScope, start, end) {
  return hostScope ? [start, end, hostScope.value] : [start, end];
}

function inferArtistFromDisplayTitle(displayTitle, title) {
  const display = String(displayTitle || '').trim();
  const knownTitle = String(title || '').trim();
  if (!display) return null;
  for (const separator of [' — ', ' – ', ' - ', ' · ', ' • ']) {
    const index = display.lastIndexOf(separator);
    if (index <= 0) continue;
    const left = display.slice(0, index).trim();
    const right = display.slice(index + separator.length).trim();
    if (!right || /^JP[A-Z0-9]{8,}$/i.test(right)) continue;
    if (!knownTitle || left === knownTitle || display.startsWith(`${knownTitle}${separator}`)) return right;
  }
  return null;
}

function metadataFallback(rawValue) {
  const raw = safeJson(rawValue, {}) || {};
  const appleResults = raw?.apple?.results || raw?.results || [];
  const apple = Array.isArray(appleResults) ? appleResults.find((item) => item?.artistName || item?.trackName) : null;
  const spotify = raw?.spotify || raw;
  return {
    artist: apple?.artistName || spotify?.author_name || spotify?.author || null,
    title: apple?.trackName || spotify?.title || null,
  };
}

function computePlayback(queue, now = Date.now()) {
  if (!queue.length) return { currentIndex: -1, progressMs: 0 };
  const start = num(queue[0].start_time);
  if (!start) return { currentIndex: 0, progressMs: 0 };
  const elapsedMs = Math.max(0, now - start);
  let cursor = 0;
  for (let i = 0; i < queue.length; i += 1) {
    const duration = Math.max(0, num(queue[i].duration_ms) || 0);
    if (elapsedMs < cursor + duration || i === queue.length - 1) {
      return { currentIndex: i, progressMs: Math.max(0, Math.min(duration, elapsedMs - cursor)) };
    }
    cursor += duration;
  }
  return { currentIndex: queue.length - 1, progressMs: 0 };
}

function linearRegressionPrediction(rows, goal, now = Date.now()) {
  const points = rows.map((r) => ({ t: num(r.observed_at), y: num(r.current_stream_count) }))
    .filter((p) => p.t != null && p.y != null).sort((a, b) => a.t - b.t);
  if (!goal || points.length < 5) return null;
  const firstT = points[0].t;
  const spanMs = points.at(-1).t - firstT;
  if (spanMs < 15 * 60000) return null;
  const xs = points.map((p) => (p.t - firstT) / 3600000);
  const ys = points.map((p) => p.y);
  const xMean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const yMean = ys.reduce((a, b) => a + b, 0) / ys.length;
  let cov = 0; let varX = 0;
  for (let i = 0; i < xs.length; i += 1) {
    cov += (xs[i] - xMean) * (ys[i] - yMean);
    varX += (xs[i] - xMean) ** 2;
  }
  if (varX <= 0) return null;
  const ratePerHour = cov / varX;
  if (!Number.isFinite(ratePerHour) || ratePerHour <= 0) return null;
  const latest = points.at(-1).y;
  const remaining = Math.max(0, goal - latest);
  return {
    eta: remaining === 0 ? now : now + (remaining / ratePerHour) * 3600000,
    rate_per_hour: ratePerHour,
    remaining,
    sample_count: points.length,
    span_hours: spanMs / 3600000,
  };
}

const LATEST_SQL = `SELECT
  id,observed_at,channel_id,channel_alias,channel_name,station_id,
  is_launched,is_broadcasting,chat_status,listener_count,online_member_count,
  total_member_count,guest_count,total_listens,stream_goal,current_stream_count,
  host_account_id,host_handle,broadcast_start_time,comment_velocity,raw_json
FROM sh_channel_snapshots ORDER BY observed_at DESC,id DESC LIMIT 1`;

const HISTORY_24H_SQL = `WITH ranked AS (
  SELECT id,observed_at,listener_count,online_member_count,total_member_count,
    total_listens,current_stream_count,stream_goal,
    ROW_NUMBER() OVER (
      PARTITION BY CAST(observed_at/300000 AS INTEGER)
      ORDER BY observed_at DESC,id DESC
    ) AS rn
  FROM sh_channel_snapshots
  WHERE observed_at >= (unixepoch('now','-24 hours')*1000)
)
SELECT observed_at,listener_count,online_member_count,total_member_count,
  total_listens,current_stream_count,stream_goal
FROM ranked WHERE rn=1 ORDER BY observed_at ASC LIMIT 300`;

function publicLatest(latest, channel, station, owner, goal) {
  if (!latest) return null;
  return {
    observed_at: latest.observed_at,
    channel_id: latest.channel_id,
    channel_alias: latest.channel_alias,
    channel_name: latest.channel_name,
    station_id: latest.station_id,
    is_launched: latest.is_launched,
    is_broadcasting: latest.is_broadcasting,
    chat_status: latest.chat_status,
    listener_count: latest.listener_count,
    online_member_count: latest.online_member_count,
    total_member_count: latest.total_member_count,
    guest_count: latest.guest_count,
    total_listens: latest.total_listens,
    stream_goal: goal,
    current_stream_count: latest.current_stream_count ?? station?.streaming_party?.current_stream_count ?? null,
    host_account_id: latest.host_account_id,
    host_handle: latest.host_handle,
    broadcast_start_time: latest.broadcast_start_time,
    comment_velocity: latest.comment_velocity,
    description: channel.description || station.status || null,
    artist_name: channel.artist_name || null,
    accent_color: channel.accent_color || null,
    channel_image: channel.images?.medium?.url || null,
    logo_image: channel.images?.logo?.medium?.url || null,
    host_image: owner.thumbnail?.url || owner.medium?.url || null,
  };
}

export async function onRequestGet({ request, env }) {
  const db = env.DB;
  if (!db) return json({ ok: false, error: 'DB binding missing' }, 500, 'no-store');
  try {
    const url = new URL(request.url);
    const since = Math.max(0, Number(url.searchParams.get('since')) || 0);
    const initial = since <= 0;
    const midnightRange = jstDayRange(Date.now(), 0);
    const memberRange = jstDayRange(Date.now(), 16);

    const historyStatement = initial
      ? db.prepare(HISTORY_24H_SQL)
      : db.prepare(`SELECT observed_at,listener_count,online_member_count,total_member_count,
          total_listens,current_stream_count,stream_goal
        FROM sh_channel_snapshots WHERE observed_at>?
        ORDER BY observed_at ASC,id ASC LIMIT 180`).bind(since);

    const [latest, historyResult, latestQueue] = await Promise.all([
      db.prepare(LATEST_SQL).first(),
      historyStatement.all(),
      db.prepare(`SELECT station_id,queue_id,start_time,is_paused,observed_at
        FROM sh_queue_snapshots ORDER BY observed_at DESC,id DESC LIMIT 1`).first(),
    ]);

    const hostScope = hostScopeFromSnapshot(latest);
    const [previousMembers, previousListens] = await Promise.all([
      db.prepare(hostScopedLatestSql('total_member_count', hostScope))
        .bind(...hostScopedBinds(hostScope, memberRange.previousStart, memberRange.currentStart))
        .first(),
      db.prepare(hostScopedLatestSql('total_listens', hostScope))
        .bind(...hostScopedBinds(hostScope, midnightRange.previousStart, midnightRange.currentStart))
        .first(),
    ]);

    const history = historyResult.results || [];
    const predictionRows = initial
      ? history
      : (await db.prepare(HISTORY_24H_SQL).all()).results || [];

    let queue = [];
    if (latestQueue) {
      const result = await db.prepare(`SELECT q.observed_at,q.station_id,q.queue_id,q.start_time,q.position,
        q.queue_track_id,q.stationhead_track_id,q.spotify_id,q.apple_music_id,q.deezer_id,q.isrc,
        q.duration_ms,q.preview_url,q.bite_count,m.title,m.artist,m.display_title,m.thumbnail_url,
        m.spotify_url,m.fetched_at AS metadata_fetched_at,m.raw_json AS metadata_raw_json
        FROM sh_queue_items q LEFT JOIN sh_track_metadata m ON m.spotify_id=q.spotify_id
        WHERE q.station_id=? AND q.start_time=? ORDER BY q.position ASC LIMIT 80`)
        .bind(latestQueue.station_id, latestQueue.start_time).all();
      queue = result.results || [];
    }

    const playback = computePlayback(queue);
    const startIndex = Math.max(0, playback.currentIndex);
    const enrichedQueue = queue.slice(startIndex).map((track, index) => {
      const fallback = metadataFallback(track.metadata_raw_json);
      const artist = String(track.artist || fallback.artist || '').trim();
      const validArtist = artist && !/^JP[A-Z0-9]{8,}$/i.test(artist)
        ? artist : inferArtistFromDisplayTitle(track.display_title || fallback.title, track.title || fallback.title);
      return {
        observed_at: track.observed_at,
        station_id: track.station_id,
        queue_id: track.queue_id,
        start_time: track.start_time,
        position: track.position,
        queue_track_id: track.queue_track_id,
        stationhead_track_id: track.stationhead_track_id,
        spotify_id: track.spotify_id,
        apple_music_id: track.apple_music_id,
        deezer_id: track.deezer_id,
        isrc: track.isrc,
        duration_ms: track.duration_ms,
        preview_url: track.preview_url,
        bite_count: track.bite_count,
        artist: validArtist || null,
        title: track.title || fallback.title || null,
        display_title: track.display_title || (fallback.title && validArtist ? `${fallback.title} — ${validArtist}` : fallback.title) || track.title || track.spotify_id || '曲情報なし',
        thumbnail_url: track.thumbnail_url || null,
        spotify_url: track.spotify_url || (track.spotify_id ? `https://open.spotify.com/track/${track.spotify_id}` : null),
        metadata_fetched_at: track.metadata_fetched_at,
        is_current: startIndex + index === playback.currentIndex,
        progress_ms: startIndex + index === playback.currentIndex ? playback.progressMs : 0,
      };
    });

    const channel = safeJson(latest?.raw_json, {}) || {};
    const station = channel.current_station || {};
    const owner = station.owner || {};
    const streaming = station.streaming_party || {};
    const goal = latest?.stream_goal ?? streaming.stream_goal ?? null;

    return json({
      ok: true,
      generated_at: Date.now(),
      delta: !initial,
      latest_observed_at: latest?.observed_at || since,
      latest: publicLatest(latest, channel, station, owner, goal),
      history,
      daily_change: latest ? {
        host_account_id: latest.host_account_id ?? null,
        host_handle: latest.host_handle ?? null,
        member_baseline_observed_at: previousMembers?.observed_at || null,
        listens_baseline_observed_at: previousListens?.observed_at || null,
        member_cutoff_hour_jst: 16,
        total_member_count: previousMembers && num(latest.total_member_count) != null && num(previousMembers.total_member_count) != null
          ? num(latest.total_member_count) - num(previousMembers.total_member_count) : null,
        total_listens: previousListens && num(latest.total_listens) != null && num(previousListens.total_listens) != null
          ? num(latest.total_listens) - num(previousListens.total_listens) : null,
      } : null,
      goal_prediction: linearRegressionPrediction(predictionRows, num(goal)),
      queue: enrichedQueue,
      queue_status: latestQueue ? {
        ...latestQueue,
        current_index: playback.currentIndex,
        progress_ms: playback.progressMs,
        total_items: queue.length,
      } : null,
    });
  } catch (error) {
    console.error(error);
    return json({ ok: false, error: error?.message || 'dashboard error' }, 500, 'no-store');
  }
}
