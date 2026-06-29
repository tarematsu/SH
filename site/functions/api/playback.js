const CACHE_CONTROL = 'public, max-age=5, s-maxage=10, stale-while-revalidate=30';

function json(data, status = 200, cache = CACHE_CONTROL) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': cache,
      'vary': 'accept-encoding',
    },
  });
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function safeJson(value, fallback = null) {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
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
  const apple = Array.isArray(appleResults)
    ? appleResults.find((item) => item?.artistName || item?.trackName)
    : null;
  const spotify = raw?.spotify || raw;
  return {
    artist: apple?.artistName || spotify?.author_name || spotify?.author || null,
    title: apple?.trackName || spotify?.title || null,
  };
}

export function computePlayback(queue, now = Date.now()) {
  if (!queue.length) return { currentIndex: -1, progressMs: 0, anchorAt: null, queueEndAt: null };
  const queueStart = numberOrNull(queue[0]?.start_time);
  if (!queueStart) return { currentIndex: 0, progressMs: 0, anchorAt: now, queueEndAt: null };

  const elapsedMs = Math.max(0, now - queueStart);
  let cursor = 0;
  let queueDurationMs = 0;
  for (const track of queue) queueDurationMs += Math.max(0, numberOrNull(track.duration_ms) || 0);

  for (let index = 0; index < queue.length; index += 1) {
    const durationMs = Math.max(0, numberOrNull(queue[index]?.duration_ms) || 0);
    if (elapsedMs < cursor + durationMs || index === queue.length - 1) {
      return {
        currentIndex: index,
        progressMs: Math.max(0, Math.min(durationMs, elapsedMs - cursor)),
        anchorAt: queueStart + cursor,
        queueEndAt: queueStart + queueDurationMs,
      };
    }
    cursor += durationMs;
  }

  return { currentIndex: queue.length - 1, progressMs: 0, anchorAt: queueStart, queueEndAt: queueStart + queueDurationMs };
}

function normalizeTrack(track, index, playback) {
  const fallback = metadataFallback(track.metadata_raw_json);
  const title = String(track.title || fallback.title || '').trim();
  const rawArtist = String(track.artist || fallback.artist || '').trim();
  const artist = rawArtist && !/^JP[A-Z0-9]{8,}$/i.test(rawArtist)
    ? rawArtist
    : inferArtistFromDisplayTitle(track.display_title || fallback.title, title || fallback.title);
  const spotifyId = String(track.spotify_id || '').trim() || null;
  const durationMs = Math.max(0, numberOrNull(track.duration_ms) || 0);

  return {
    position: numberOrNull(track.position),
    queue_track_id: numberOrNull(track.queue_track_id),
    stationhead_track_id: numberOrNull(track.stationhead_track_id),
    spotify_id: spotifyId,
    isrc: String(track.isrc || '').trim() || null,
    title: title || track.display_title || spotifyId || '曲情報なし',
    artist: artist || null,
    display_title: track.display_title || (title && artist ? `${title} — ${artist}` : title) || spotifyId || '曲情報なし',
    thumbnail_url: track.thumbnail_url || null,
    spotify_url: track.spotify_url || (spotifyId ? `https://open.spotify.com/track/${spotifyId}` : null),
    duration_ms: durationMs,
    metadata_fetched_at: numberOrNull(track.metadata_fetched_at),
    is_current: index === playback.currentIndex,
    progress_ms: index === playback.currentIndex ? playback.progressMs : 0,
  };
}

export async function onRequestGet({ env }) {
  const db = env.DB;
  if (!db) return json({ ok: false, error: 'DB binding missing' }, 500, 'no-store');

  try {
    const generatedAt = Date.now();
    const [latest, latestQueue] = await Promise.all([
      db.prepare(`SELECT observed_at,station_id,is_broadcasting,host_account_id,host_handle,broadcast_start_time
        FROM sh_channel_snapshots ORDER BY observed_at DESC,id DESC LIMIT 1`).first(),
      db.prepare(`SELECT station_id,queue_id,start_time,is_paused,observed_at
        FROM sh_queue_snapshots ORDER BY observed_at DESC,id DESC LIMIT 1`).first(),
    ]);

    if (!latestQueue) {
      return json({
        ok: true,
        generated_at: generatedAt,
        latest_observed_at: numberOrNull(latest?.observed_at),
        station_id: numberOrNull(latest?.station_id),
        is_broadcasting: Boolean(latest?.is_broadcasting),
        host_handle: latest?.host_handle || null,
        queue_status: null,
        queue: [],
      });
    }

    const result = await db.prepare(`SELECT q.position,q.queue_track_id,q.stationhead_track_id,q.spotify_id,q.isrc,
      q.duration_ms,m.title,m.artist,m.display_title,m.thumbnail_url,m.spotify_url,
      m.fetched_at AS metadata_fetched_at,m.raw_json AS metadata_raw_json
      FROM sh_queue_items q LEFT JOIN sh_track_metadata m ON m.spotify_id=q.spotify_id
      WHERE q.station_id=? AND q.start_time=? ORDER BY q.position ASC LIMIT 80`)
      .bind(latestQueue.station_id, latestQueue.start_time).all();

    const rows = result.results || [];
    const queueForPlayback = rows.map((track) => ({ ...track, start_time: latestQueue.start_time }));
    const playback = computePlayback(queueForPlayback, generatedAt);
    const queue = rows.map((track, index) => normalizeTrack(track, index, playback));
    const paused = Boolean(latestQueue.is_paused);
    const broadcasting = latest?.is_broadcasting !== 0 && latest?.is_broadcasting !== false;

    return json({
      ok: true,
      generated_at: generatedAt,
      latest_observed_at: numberOrNull(latest?.observed_at),
      queue_observed_at: numberOrNull(latestQueue.observed_at),
      station_id: numberOrNull(latestQueue.station_id),
      is_broadcasting: broadcasting,
      host_account_id: numberOrNull(latest?.host_account_id),
      host_handle: latest?.host_handle || null,
      broadcast_start_time: numberOrNull(latest?.broadcast_start_time),
      playing: broadcasting && !paused && playback.currentIndex >= 0,
      queue_revision: `${latestQueue.station_id || ''}:${latestQueue.queue_id || ''}:${latestQueue.start_time || ''}`,
      queue_status: {
        queue_id: numberOrNull(latestQueue.queue_id),
        start_time: numberOrNull(latestQueue.start_time),
        is_paused: paused,
        current_index: playback.currentIndex,
        progress_ms: playback.progressMs,
        anchor_at: playback.anchorAt,
        queue_end_at: playback.queueEndAt,
        total_items: queue.length,
      },
      queue,
    });
  } catch (error) {
    console.error(error);
    return json({ ok: false, error: error?.message || 'playback feed error' }, 500, 'no-store');
  }
}
