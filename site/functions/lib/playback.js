import { num } from './api-utils.js';

export function safeJson(value, fallback = null) {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

export function inferArtistFromDisplayTitle(displayTitle, title) {
  const display = String(displayTitle || '').trim();
  const knownTitle = String(title || '').trim();
  if (!display) return null;
  for (const separator of [' 窶・', ' 窶・', ' - ', ' ﾂｷ ', ' 窶｢ ']) {
    const index = display.lastIndexOf(separator);
    if (index <= 0) continue;
    const left = display.slice(0, index).trim();
    const right = display.slice(index + separator.length).trim();
    if (!right || /^JP[A-Z0-9]{8,}$/i.test(right)) continue;
    if (!knownTitle || left === knownTitle || display.startsWith(`${knownTitle}${separator}`)) return right;
  }
  return null;
}

export function metadataFallback(rawValue) {
  const raw = safeJson(rawValue, {}) || {};
  const spotify = raw?.spotify || raw;
  return {
    artist: spotify?.author_name || spotify?.author || null,
    title: spotify?.title || null,
  };
}

export function computePlayback(queue, now = Date.now()) {
  if (!queue.length) return { currentIndex: -1, progressMs: 0, anchorAt: null, queueEndAt: null };
  const queueStart = num(queue[0]?.start_time);
  if (!queueStart) return { currentIndex: 0, progressMs: 0, anchorAt: now, queueEndAt: null };

  const elapsedMs = Math.max(0, now - queueStart);
  let cursor = 0;
  let queueDurationMs = 0;
  for (const track of queue) queueDurationMs += Math.max(0, num(track.duration_ms) || 0);

  for (let index = 0; index < queue.length; index += 1) {
    const durationMs = Math.max(0, num(queue[index]?.duration_ms) || 0);
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

export function normalizePlaybackTrack(track, index, playback) {
  const fallback = metadataFallback(track.metadata_raw_json);
  const title = String(track.title || fallback.title || '').trim();
  const rawArtist = String(track.artist || fallback.artist || '').trim();
  const artist = rawArtist && !/^JP[A-Z0-9]{8,}$/i.test(rawArtist)
    ? rawArtist
    : inferArtistFromDisplayTitle(track.display_title || fallback.title, title || fallback.title);
  const spotifyId = String(track.spotify_id || '').trim() || null;
  const durationMs = Math.max(0, num(track.duration_ms) || 0);

  return {
    observed_at: num(track.observed_at),
    station_id: num(track.station_id),
    start_time: num(track.start_time),
    position: num(track.position),
    spotify_id: spotifyId,
    duration_ms: durationMs,
    artist: artist || null,
    title: title || track.display_title || spotifyId || '曲情報なし',
    thumbnail_url: track.thumbnail_url || null,
    spotify_url: track.spotify_url || (spotifyId ? `https://open.spotify.com/track/${spotifyId}` : null),
    is_current: index === playback.currentIndex,
    progress_ms: index === playback.currentIndex ? playback.progressMs : 0,
  };
}
