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

function jstDayRange(now = Date.now()) {
  const shifted = new Date(now + 9 * 3600000);
  const todayStart = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - 9 * 3600000;
  return { previousStart: todayStart - 86400000, todayStart };
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
  const deduped = [];
  let lastBucket = null;
  for (const p of points) {
    const bucket = Math.floor(p.t / 60000);
    if (bucket === lastBucket) deduped[deduped.length - 1] = p;
    else deduped.push(p);
    lastBucket = bucket;
  }
  const xs = deduped.map((p) => (p.t - firstT) / 3600000);
  const ys = deduped.map((p) => p.y);
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
  const latest = deduped.at(-1).y;
  const remaining = Math.max(0, goal - latest);
  return {
    eta: remaining === 0 ? now : now + (remaining / ratePerHour) * 3600000,
    rate_per_hour: ratePerHour,
    remaining,
    sample_count: deduped.length,
    span_hours: spanMs / 3600000,
  };
}

export async function onRequestGet({ request, env }) {
  const db = env.DB;
  if (!db) return json({ ok: false, error: 'DB binding missing' }, 500, 'no-store');
  try {
    const url = new URL(request.url);
    const since = Math.max(0, Number(url.searchParams.get('since')) || 0);
    const initial = since <= 0;

    const latest = await db.prepare(`SELECT * FROM sh_channel_snapshots ORDER BY observed_at DESC LIMIT 1`).first();
    const historySql = initial
      ? `SELECT observed_at,listener_count,online_member_count,total_member_count,total_listens,current_stream_count,stream_goal
         FROM sh_channel_snapshots WHERE observed_at >= (unixepoch('now','-24 hours')*1000)
         ORDER BY observed_at ASC LIMIT 1500`
      : `SELECT observed_at,listener_count,online_member_count,total_member_count,total_listens,current_stream_count,stream_goal
         FROM sh_channel_snapshots WHERE observed_at > ? ORDER BY observed_at ASC LIMIT 180`;
    const historyResult = initial
      ? await db.prepare(historySql).all()
      : await db.prepare(historySql).bind(since).all();
    const history = historyResult.results || [];

    const predictionRows = initial
      ? history
      : (await db.prepare(`SELECT observed_at,current_stream_count FROM sh_channel_snapshots
          WHERE observed_at >= (unixepoch('now','-24 hours')*1000)
          ORDER BY observed_at ASC LIMIT 1500`).all()).results || [];

    const { previousStart, todayStart } = jstDayRange();
    const previousDay = await db.prepare(`SELECT observed_at,total_member_count,total_listens
      FROM sh_channel_snapshots WHERE observed_at>=? AND observed_at<? ORDER BY observed_at DESC LIMIT 1`)
      .bind(previousStart, todayStart).first();

    const latestQueue = await db.prepare(`SELECT station_id,queue_id,start_time,is_paused,observed_at
      FROM sh_queue_snapshots ORDER BY observed_at DESC LIMIT 1`).first();
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
        ...track,
        artist: validArtist || null,
        title: track.title || fallback.title || null,
        display_title: track.display_title || (fallback.title && validArtist ? `${fallback.title} — ${validArtist}` : fallback.title) || track.title || track.spotify_id || '曲情報なし',
        spotify_url: track.spotify_url || (track.spotify_id ? `https://open.spotify.com/track/${track.spotify_id}` : null),
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
      latest: latest ? {
        ...latest,
        description: channel.description || station.status || null,
        artist_name: channel.artist_name || null,
        accent_color: channel.accent_color || null,
        channel_image: channel.images?.medium?.url || null,
        logo_image: channel.images?.logo?.medium?.url || null,
        host_image: owner.thumbnail?.url || owner.medium?.url || null,
        stream_goal: goal,
        current_stream_count: latest.current_stream_count ?? streaming.current_stream_count ?? null,
      } : null,
      history,
      daily_change: previousDay && latest ? {
        baseline_observed_at: previousDay.observed_at,
        total_member_count: num(latest.total_member_count) != null && num(previousDay.total_member_count) != null
          ? num(latest.total_member_count) - num(previousDay.total_member_count) : null,
        total_listens: num(latest.total_listens) != null && num(previousDay.total_listens) != null
          ? num(latest.total_listens) - num(previousDay.total_listens) : null,
      } : null,
      goal_prediction: linearRegressionPrediction(predictionRows, num(goal)),
      queue: enrichedQueue,
      queue_status: latestQueue ? { ...latestQueue, current_index: playback.currentIndex, progress_ms: playback.progressMs, total_items: queue.length } : null,
    });
  } catch (error) {
    console.error(error);
    return json({ ok: false, error: error?.message || 'dashboard error' }, 500, 'no-store');
  }
}
