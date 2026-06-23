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

async function spotifyMetadata(id) {
  if (!id) return null;
  const trackUrl = `https://open.spotify.com/track/${encodeURIComponent(id)}`;
  try {
    const response = await fetch(
      `https://open.spotify.com/oembed?url=${encodeURIComponent(trackUrl)}`,
      { headers: { accept: 'application/json' } },
    );
    if (!response.ok) {
      return { spotify_id: id, spotify_url: trackUrl, title: id };
    }

    const data = await response.json();
    const rawTitle = data.title || '';
    const cleaned = rawTitle
      .replace(/\s*\|\s*Spotify\s*$/i, '')
      .replace(/\s*-\s*song and lyrics by\s*/i, ' — ')
      .trim();
    const [title, ...artistParts] = cleaned.split(/\s+—\s+/);

    return {
      spotify_id: id,
      spotify_url: trackUrl,
      title: title || rawTitle || id,
      artist: artistParts.join(' — ') || null,
      display_title: cleaned || rawTitle || id,
      thumbnail_url: data.thumbnail_url || null,
    };
  } catch (error) {
    console.warn('spotify metadata failed', id, error?.message || error);
    return { spotify_id: id, spotify_url: trackUrl, title: id };
  }
}

function computePlayback(queue, now = Date.now()) {
  if (!queue.length) return { currentIndex: -1, progressMs: 0, elapsedMs: 0 };
  const start = num(queue[0].start_time);
  if (!start) return { currentIndex: 0, progressMs: 0, elapsedMs: 0 };

  const elapsedMs = Math.max(0, now - start);
  let cursor = 0;
  for (let i = 0; i < queue.length; i += 1) {
    const duration = Math.max(0, num(queue[i].duration_ms) || 0);
    if (elapsedMs < cursor + duration || i === queue.length - 1) {
      return {
        currentIndex: i,
        progressMs: Math.max(0, Math.min(duration, elapsedMs - cursor)),
        elapsedMs,
      };
    }
    cursor += duration;
  }
  return { currentIndex: queue.length - 1, progressMs: 0, elapsedMs };
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

    const comments = await db.prepare(`
      SELECT id, observed_at, account_id, handle, text, chat_time_ms,
             all_access_chat, boost_chat, active_stream_days, followers, emoji
      FROM sh_comments
      ORDER BY COALESCE(chat_time_ms, observed_at) DESC
      LIMIT 60
    `).all();

    const latestQueue = await db.prepare(`
      SELECT station_id, queue_id, start_time, is_paused, observed_at
      FROM sh_queue_snapshots
      ORDER BY observed_at DESC LIMIT 1
    `).first();

    let queue = [];
    if (latestQueue) {
      const result = await db.prepare(`
        SELECT observed_at, station_id, queue_id, start_time, position,
               queue_track_id, stationhead_track_id, spotify_id, apple_music_id,
               deezer_id, isrc, duration_ms, preview_url, bite_count
        FROM sh_queue_items
        WHERE station_id = ? AND start_time = ?
        ORDER BY position ASC
        LIMIT 80
      `).bind(latestQueue.station_id, latestQueue.start_time).all();
      queue = result.results || [];
    }

    const playback = computePlayback(queue);
    const startIndex = Math.max(0, playback.currentIndex);
    const visibleQueue = queue.slice(startIndex, startIndex + 13);
    const metadata = await Promise.all(visibleQueue.map((track) => spotifyMetadata(track.spotify_id)));
    const enrichedQueue = visibleQueue.map((track, index) => ({
      ...track,
      ...metadata[index],
      is_current: startIndex + index === playback.currentIndex,
      progress_ms: startIndex + index === playback.currentIndex ? playback.progressMs : 0,
    }));

    const raw = safeJson(latest?.raw_json, {});
    const channel = raw || {};
    const station = channel.current_station || {};
    const owner = station.owner || {};
    const streaming = station.streaming_party || {};

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
        stream_goal: latest.stream_goal ?? streaming.stream_goal ?? null,
        current_stream_count: latest.current_stream_count ?? streaming.current_stream_count ?? null,
      } : null,
      history: history.results || [],
      comments: comments.results || [],
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
    return json({ ok: false, error: error?.message || 'dashboard error', stack: error?.stack || null }, 500);
  }
}
