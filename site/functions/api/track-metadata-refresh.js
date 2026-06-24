const HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: HEADERS });
const clean = (value) => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim() || null;
const looksLikeId = (value) => /^[0-9A-Za-z]{15,}$/.test(clean(value) || '');

function parseTitle(value) {
  const text = clean(value)?.replace(/\s*\|\s*Spotify\s*$/i, '') || null;
  if (!text) return { title: null, artist: null };
  const match = text.match(/^(.*?)\s*-\s*song and lyrics by\s*(.+)$/i);
  return match
    ? { title: clean(match[1]), artist: clean(match[2]) }
    : { title: text, artist: null };
}

async function fetchSpotify(spotifyId) {
  try {
    const trackUrl = `https://open.spotify.com/track/${encodeURIComponent(spotifyId)}`;
    const response = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(trackUrl)}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    const raw = await response.json();
    const parsed = parseTitle(raw?.title);
    const title = parsed.title;
    const artist = clean(raw?.author_name || raw?.author) || parsed.artist;
    if (!title || looksLikeId(title)) return null;
    return { title, artist, spotify_url: trackUrl, raw };
  } catch {
    return null;
  }
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500);
  const url = new URL(request.url);
  const origin = request.headers.get('origin');
  if (origin && origin !== url.origin) return json({ ok: false, error: 'forbidden' }, 403);

  try {
    const result = await env.DB.prepare(`
      SELECT DISTINCT q.spotify_id
      FROM sh_queue_items q
      LEFT JOIN sh_track_metadata m ON m.spotify_id = q.spotify_id
      WHERE q.spotify_id IS NOT NULL
        AND q.spotify_id <> ''
        AND (
          m.spotify_id IS NULL
          OR m.title IS NULL OR m.title = '' OR m.title = q.spotify_id
          OR m.artist IS NULL OR m.artist = '' OR m.artist = q.spotify_id
        )
      ORDER BY q.observed_at DESC
      LIMIT 25
    `).all();

    const ids = (result.results || []).map((row) => row.spotify_id).filter(Boolean);
    if (!ids.length) return json({ ok: true, processed: 0, updated: 0, done: true });

    const resolved = [];
    for (let index = 0; index < ids.length; index += 5) {
      const chunk = ids.slice(index, index + 5);
      const values = await Promise.all(chunk.map(async (id) => [id, await fetchSpotify(id)]));
      resolved.push(...values.filter(([, value]) => value));
    }

    if (resolved.length) {
      const now = Date.now();
      await env.DB.batch(resolved.map(([spotifyId, value]) => env.DB.prepare(`
        INSERT INTO sh_track_metadata (
          spotify_id,title,artist,display_title,spotify_url,source,fetched_at,raw_json
        ) VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(spotify_id) DO UPDATE SET
          title=CASE WHEN excluded.title IS NOT NULL AND excluded.title<>'' THEN excluded.title ELSE sh_track_metadata.title END,
          artist=CASE WHEN excluded.artist IS NOT NULL AND excluded.artist<>'' THEN excluded.artist ELSE sh_track_metadata.artist END,
          display_title=CASE WHEN excluded.display_title IS NOT NULL AND excluded.display_title<>'' THEN excluded.display_title ELSE sh_track_metadata.display_title END,
          spotify_url=COALESCE(excluded.spotify_url,sh_track_metadata.spotify_url),
          source=excluded.source,
          fetched_at=excluded.fetched_at,
          raw_json=excluded.raw_json
      `).bind(
        spotifyId,
        value.title,
        value.artist,
        value.title && value.artist ? `${value.title} — ${value.artist}` : value.title,
        value.spotify_url,
        'spotify_oembed_bulk',
        now,
        JSON.stringify(value.raw || null),
      )));
    }

    const remaining = await env.DB.prepare(`
      SELECT COUNT(DISTINCT q.spotify_id) AS count
      FROM sh_queue_items q
      LEFT JOIN sh_track_metadata m ON m.spotify_id = q.spotify_id
      WHERE q.spotify_id IS NOT NULL
        AND q.spotify_id <> ''
        AND (
          m.spotify_id IS NULL
          OR m.title IS NULL OR m.title = '' OR m.title = q.spotify_id
          OR m.artist IS NULL OR m.artist = '' OR m.artist = q.spotify_id
        )
    `).first();

    return json({
      ok: true,
      processed: ids.length,
      updated: resolved.length,
      remaining: Number(remaining?.count || 0),
      done: Number(remaining?.count || 0) === 0,
    });
  } catch (error) {
    return json({ ok: false, error: error?.message || 'metadata refresh failed' }, 500);
  }
}
