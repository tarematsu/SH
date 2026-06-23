const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'public, max-age=20, stale-while-revalidate=60',
  },
});

const safeJson = (value, fallback = null) => {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
};

const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

function computePlayback(queue, now = Date.now()) {
  if (!queue.length) return { currentIndex: -1, progressMs: 0 };
  const start = num(queue[0].start_time);
  if (!start) return { currentIndex: 0, progressMs: 0 };

  const elapsedMs = Math.max(0, now - start);
  let cursor = 0;
  for (let i = 0; i < queue.length; i += 1) {
    const duration = Math.max(0, num(queue[i].duration_ms) || 0);
    if (elapsedMs < cursor + duration || i === queue.length - 1) {
      return {
        currentIndex: i,
        progressMs: Math.max(0, Math.min(duration, elapsedMs - cursor)),
      };
    }
    cursor += duration;
  }
  return { currentIndex: queue.length - 1, progressMs: 0 };
}

function linearRegressionPrediction(rows, goal, now = Date.now()) {
  const points = rows
    .map((r) => ({ t: num(r.observed_at), y: num(r.current_stream_count) }))
    .filter((p) => p.t != null && p.y != null)
    .sort((a, b) => a.t - b.t);

  if (!goal || points.length < 5) return null;
  const firstT = points[0].t;
  const spanMs = points.at(-1).t - firstT;
  if (spanMs < 15 * 60_000) return null;

  const deduped = [];
  let lastBucket = null;
  for (const p of points) {
    const bucket = Math.floor(p.t / 60_000);
    if (bucket === lastBucket) deduped[deduped.length - 1] = p;
    else deduped.push(p);
    lastBucket = bucket;
  }

  const xs = deduped.map((p) => (p.t - firstT) / 3_600_000);
  const ys = deduped.map((p) => p.y);
  const xMean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const yMean = ys.reduce((a, b) => a + b, 0) / ys.length;
  let cov = 0;
  let varX = 0;
  for (let i = 0; i < xs.length; i += 1) {
    cov += (xs[i] - xMean) * (ys[i] - yMean);
    varX += (xs[i] - xMean) ** 2;
  }
  if (varX <= 0) return null;

  const ratePerHour = cov / varX;
  if (!Number.isFinite(ratePerHour) || ratePerHour <= 0) return null;
  const intercept = yMean - ratePerHour * xMean;

  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < xs.length; i += 1) {
    const predicted = intercept + ratePerHour * xs[i];
    ssRes += (ys[i] - predicted) ** 2;
    ssTot += (ys[i] - yMean) ** 2;
  }
  const r2 = ssTot > 0 ? Math.max(0, Math.min(1, 1 - ssRes / ssTot)) : 0;
  const latest = deduped.at(-1).y;
  const remaining = Math.max(0, goal - latest);
  const hoursRemaining = remaining / ratePerHour;
  const eta = remaining === 0 ? now : now + hoursRemaining * 3_600_000;
  const confidence = r2 >= 0.9 && spanMs >= 6 * 3_600_000 ? 'high' : r2 >= 0.65 ? 'medium' : 'low';

  return {
    eta,
    rate_per_hour: ratePerHour,
    remaining,
    r2,
    confidence,
    sample_count: deduped.length,
    span_hours: spanMs / 3_600_000,
  };
}

export async function onRequestGet(context) {
  const db = context.env.DB;
  if (!db) return json({ ok: false, error: 'DB binding missing' }, 500);

  try {
    const latest = await db.prepare(`
      SELECT * FROM sh_channel_snapshots
      ORDER BY observed_at DESC LIMIT 1
    `).first();

    const history = await db.prepare(`
      SELECT observed_at, listener_count, online_member_count,
             total_member_count, total_listens, current_stream_count, stream_goal
      FROM sh_channel_snapshots
      WHERE observed_at >= (unixepoch('now', '-24 hours') * 1000)
      ORDER BY observed_at ASC
      LIMIT 1500
    `).all();

    const latestQueue = await db.prepare(`
      SELECT station_id, queue_id, start_time, is_paused, observed_at
      FROM sh_queue_snapshots
      ORDER BY observed_at DESC LIMIT 1
    `).first();

    let queue = [];
    if (latestQueue) {
      const result = await db.prepare(`
        SELECT q.observed_at, q.station_id, q.queue_id, q.start_time, q.position,
               q.queue_track_id, q.stationhead_track_id, q.spotify_id, q.apple_music_id,
               q.deezer_id, q.isrc, q.duration_ms, q.preview_url, q.bite_count,
               m.title, m.artist, m.display_title, m.thumbnail_url, m.spotify_url,
               m.fetched_at AS metadata_fetched_at
        FROM sh_queue_items q
        LEFT JOIN sh_track_metadata m ON m.spotify_id = q.spotify_id
        WHERE q.station_id = ? AND q.start_time = ?
        ORDER BY q.position ASC
        LIMIT 80
      `).bind(latestQueue.station_id, latestQueue.start_time).all();
      queue = result.results || [];
    }

    const playback = computePlayback(queue);
    const startIndex = Math.max(0, playback.currentIndex);
    const visibleQueue = queue.slice(startIndex);
    const enrichedQueue = visibleQueue.map((track, index) => ({
      ...track,
      display_title: track.display_title || track.title || track.spotify_id || '曲情報取得待ち',
      spotify_url: track.spotify_url || (track.spotify_id ? `https://open.spotify.com/track/${track.spotify_id}` : null),
      is_current: startIndex + index === playback.currentIndex,
      progress_ms: startIndex + index === playback.currentIndex ? playback.progressMs : 0,
    }));

    const raw = safeJson(latest?.raw_json, {});
    const channel = raw || {};
    const station = channel.current_station || {};
    const owner = station.owner || {};
    const streaming = station.streaming_party || {};
    const goal = latest?.stream_goal ?? streaming.stream_goal ?? null;
    const prediction = linearRegressionPrediction(history.results || [], num(goal));

    return json({
      ok: true,
      generated_at: Date.now(),
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
      history: history.results || [],
      goal_prediction: prediction,
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
    return json({ ok: false, error: error?.message || 'dashboard error' }, 500);
  }
}
