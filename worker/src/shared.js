export function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export function normalizeBearer(value) {
  return String(value || '').replace(/^Bearer\s+/i, '').trim();
}

export function jwtExpiryMs(token) {
  try {
    const part = String(token || '').split('.')[1];
    if (!part) return 0;
    const normalized = part.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const payload = JSON.parse(atob(padded));
    return Number(payload.exp || 0) * 1000;
  } catch {
    return 0;
  }
}

export function positiveNumber(value, fallback) {
  const n = Number(value ?? fallback);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function highResolutionArtwork(url) {
  if (!url) return null;
  return String(url)
    .replace(/\/\d+x\d+bb\./, '/600x600bb.')
    .replace(/\/\d+x\d+-\d+\./, '/600x600-75.');
}

export function cleanSpotifyTitle(rawTitle) {
  const cleaned = String(rawTitle || '')
    .replace(/\s*\|\s*Spotify\s*$/i, '')
    .trim();
  const parts = cleaned.split(/\s+[—–]\s+/);
  return {
    title: parts[0] || rawTitle || null,
    artist: parts.length > 1 ? parts.slice(1).join(' — ') : null,
    displayTitle: cleaned || rawTitle || null,
  };
}

export function normalizeComments(payload, stationId, { finite } = {}) {
  const toFinite = finite || ((value) => {
    if (value === undefined || value === null || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  });
  const candidates = [payload, payload?.items, payload?.data?.items, payload?.chats?.items, payload?.chats];
  const items = candidates.find(Array.isArray) || [];
  return items.map((chat) => ({
    comment_id: toFinite(chat?.id),
    id: chat?.id,
    station_id: toFinite(chat?.station_id ?? stationId),
    account_id: toFinite(chat?.account_id ?? chat?.account?.id),
    handle: chat?.account?.handle ?? null,
    text: chat?.text ?? null,
    text_with_xml: chat?.text_with_xml ?? null,
    chat_time: toFinite(chat?.chat_time),
    chat_time_ms: toFinite(chat?.chat_time_ms),
    all_access_chat: chat?.all_access_chat ?? null,
    boost_chat: chat?.boost_chat ?? null,
    followers: toFinite(chat?.account?.followers),
    following: toFinite(chat?.account?.following),
    active_stream_days: toFinite(chat?.active_stream_days ?? chat?.account?.active_stream_days),
    emoji: chat?.account?.emoji ?? null,
    raw: chat,
  })).filter((comment) => comment.comment_id != null || comment.id != null);
}

export async function fetchTrackMetadata(track, config) {
  const applePromise = track?.apple_music_id
    ? Promise.all(['JP', 'US'].map(async (country) => {
      const params = new URLSearchParams({ id: String(track.apple_music_id), entity: 'song', country });
      const response = await fetch(`https://itunes.apple.com/lookup?${params}`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      });
      if (!response.ok) return null;
      const raw = await response.json();
      const item = (raw.results || []).find((value) => value.kind === 'song' && value.trackName && value.artistName)
        || (raw.results || []).find((value) => value.trackName && value.artistName);
      return item ? { item, raw } : null;
    })).then((values) => values.find(Boolean) || null).catch(() => null)
    : Promise.resolve(null);

  const spotifyId = track?.spotify_id;
  const spotifyUrl = spotifyId ? `https://open.spotify.com/track/${encodeURIComponent(spotifyId)}` : null;
  const spotifyPromise = spotifyUrl
    ? fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(spotifyUrl)}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    }).then((response) => response.ok ? response.json() : null).catch(() => null)
    : Promise.resolve(null);

  const [apple, spotify] = await Promise.all([applePromise, spotifyPromise]);
  if (!apple && !spotify?.title) return null;

  const parsed = cleanSpotifyTitle(spotify?.title);
  const title = apple?.item?.trackName || parsed.title;
  const artist = apple?.item?.artistName
    || String(spotify?.author_name || spotify?.author || '').trim()
    || parsed.artist
    || null;
  return {
    spotify_id: spotifyId,
    spotify_url: spotifyUrl,
    title,
    artist,
    display_title: title && artist ? `${title} — ${artist}` : parsed.displayTitle,
    thumbnail_url: highResolutionArtwork(apple?.item?.artworkUrl100 || apple?.item?.artworkUrl60)
      || spotify?.thumbnail_url
      || null,
    source: apple ? 'apple_itunes_lookup+spotify_oembed' : 'spotify_oembed',
    fetched_at: Date.now(),
    raw: { apple: apple?.raw || null, spotify },
  };
}

export async function enrichTracks(env, ingestFn, queue, observedAt, config) {
  const candidates = [...new Map(
    (queue?.tracks || []).filter((track) => track.spotify_id).map((track) => [track.spotify_id, track]),
  ).values()];
  if (!candidates.length || (config.metadataLimit != null && config.metadataLimit <= 0)) return 0;

  const placeholders = candidates.map(() => '?').join(',');
  const stored = await env.DB.prepare(`
    SELECT spotify_id, title, artist
    FROM sh_track_metadata
    WHERE spotify_id IN (${placeholders})
  `).bind(...candidates.map((track) => track.spotify_id)).all();
  const complete = new Set((stored.results || [])
    .filter((item) => item.title && item.artist && !/^JP[A-Z0-9]{8,}$/i.test(String(item.artist)))
    .map((item) => item.spotify_id));
  const limit = config.metadataLimit ?? 3;
  const missing = candidates.filter((track) => !complete.has(track.spotify_id)).slice(0, limit);
  if (!missing.length) return 0;

  const metadata = (await Promise.all(missing.map((track) => fetchTrackMetadata(track, config)))).filter(Boolean);
  if (metadata.length) await ingestFn(env, 'track_metadata', { tracks: metadata }, observedAt);
  return metadata.length;
}
