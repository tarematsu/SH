import { bestText, cleanText, looksLikeId } from './track-history-text.js';

function parseSpotifyTitle(value) {
  const cleaned = cleanText(value)?.replace(/\s*\|\s*Spotify\s*$/i, '') || null;
  if (!cleaned) return { title: null, artist: null };
  const match = cleaned.match(/^(.*?)\s*-\s*song and lyrics by\s*(.+)$/i);
  if (match) return { title: cleanText(match[1]), artist: cleanText(match[2]) };
  return { title: cleaned, artist: null };
}

async function spotifyMetadata(spotifyId) {
  if (!spotifyId) return null;
  const cacheRequest = new Request(`https://stationhead-meta-cache.invalid/spotify/${encodeURIComponent(spotifyId)}`);
  try {
    const cached = await caches.default.match(cacheRequest);
    if (cached) return cached.json();
  } catch {}
  try {
    const spotifyUrl = `https://open.spotify.com/track/${encodeURIComponent(spotifyId)}`;
    const response = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(spotifyUrl)}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    const raw = await response.json();
    const parsed = parseSpotifyTitle(raw?.title);
    const value = {
      title: parsed.title,
      artist: cleanText(raw?.author_name || raw?.author) || parsed.artist,
      spotify_url: spotifyUrl,
      raw,
    };
    if (!value.title || looksLikeId(value.title)) return null;
    try {
      await caches.default.put(cacheRequest, new Response(JSON.stringify(value), {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'public, max-age=2592000',
        },
      }));
    } catch {}
    return value;
  } catch {
    return null;
  }
}

async function persistResolvedMetadata(env, resolved) {
  if (!resolved.size) return 0;
  const now = Date.now();
  const statements = [...resolved.entries()].map(([spotifyId, value]) => env.DB.prepare(`
    INSERT INTO sh_track_metadata (
      spotify_id,title,artist,display_title,spotify_url,fetched_at,raw_json
    ) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(spotify_id) DO UPDATE SET
      title=CASE WHEN excluded.title IS NOT NULL AND excluded.title<>'' THEN excluded.title ELSE sh_track_metadata.title END,
      artist=CASE WHEN excluded.artist IS NOT NULL AND excluded.artist<>'' THEN excluded.artist ELSE sh_track_metadata.artist END,
      display_title=CASE WHEN excluded.display_title IS NOT NULL AND excluded.display_title<>'' THEN excluded.display_title ELSE sh_track_metadata.display_title END,
      spotify_url=COALESCE(excluded.spotify_url,sh_track_metadata.spotify_url),
      fetched_at=excluded.fetched_at,
      raw_json=excluded.raw_json
  `).bind(
    spotifyId,
    value.title || null,
    value.artist || null,
    value.title && value.artist ? `${value.title} — ${value.artist}` : value.title || null,
    value.spotify_url || null,
    now,
    JSON.stringify({ source: 'spotify_oembed', spotify: value.raw || null }),
  ));
  await env.DB.batch(statements);
  return statements.length;
}

export async function enrichMissingRows(rows, env) {
  const unresolved = new Map();
  for (const row of rows) {
    const title = bestText(row.title, row.raw_title, row.display_title);
    const artist = bestText(row.artist, row.raw_artist);
    if ((!title || looksLikeId(title) || !artist || looksLikeId(artist)) && row.spotify_id) {
      unresolved.set(row.spotify_id, null);
      if (unresolved.size >= 20) break;
    }
  }
  if (!unresolved.size) return { rows, persisted: 0 };

  const ids = [...unresolved.keys()];
  const resolved = new Map();
  for (let index = 0; index < ids.length; index += 6) {
    const values = await Promise.all(ids.slice(index, index + 6).map(async (id) => [id, await spotifyMetadata(id)]));
    for (const [id, value] of values) if (value) resolved.set(id, value);
  }

  let persisted = 0;
  try {
    persisted = await persistResolvedMetadata(env, resolved);
  } catch (error) {
    console.error('track metadata D1 upsert failed', error);
  }

  return {
    persisted,
    rows: rows.map((row) => {
      const value = resolved.get(row.spotify_id);
      if (!value) return row;
      return {
        ...row,
        title: bestText(row.title, row.raw_title, row.display_title, value.title),
        artist: bestText(row.artist, row.raw_artist, value.artist),
        spotify_url: row.spotify_url || value.spotify_url || null,
      };
    }),
  };
}
