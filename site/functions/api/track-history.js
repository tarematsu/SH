const H = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'public, max-age=300, s-maxage=900, stale-while-revalidate=3600',
};
const out = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: H });
const day = () => new Date().toISOString().slice(0, 10);
const valid = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value || '');
const ts = (value) => Date.parse(`${value}T00:00:00Z`);

function cleanText(value) {
  const text = String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  return text || null;
}

function looksLikeId(value) {
  const text = cleanText(value) || '';
  return /^[0-9A-Za-z]{15,}$/.test(text) || /^JP[A-Z0-9]{8,}$/i.test(text);
}

function canonical(value) {
  return (cleanText(value) || '')
    .toLocaleLowerCase('ja-JP')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[‐‑‒–—―ー−-]/g, '-')
    .replace(/[・･·]/g, '・')
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‘’‚‛′]/g, "'");
}

function bestText(...values) {
  const candidates = values.map(cleanText).filter(Boolean);
  return candidates.find((value) => !looksLikeId(value)) || candidates[0] || null;
}

function parseSpotifyTitle(value) {
  const cleaned = cleanText(value)?.replace(/\s*\|\s*Spotify\s*$/i, '') || null;
  if (!cleaned) return { title: null, artist: null };
  const match = cleaned.match(/^(.*?)\s*-\s*song and lyrics by\s*(.+)$/i);
  if (match) return { title: cleanText(match[1]), artist: cleanText(match[2]) };
  return { title: cleaned, artist: null };
}

async function spotifyMetadata(spotifyId) {
  if (!spotifyId) return null;
  const cacheUrl = `https://stationhead-meta-cache.invalid/spotify/${encodeURIComponent(spotifyId)}`;
  const cacheRequest = new Request(cacheUrl);
  try {
    const cached = await caches.default.match(cacheRequest);
    if (cached) return cached.json();
  } catch {}

  try {
    const trackUrl = `https://open.spotify.com/track/${encodeURIComponent(spotifyId)}`;
    const response = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(trackUrl)}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    const raw = await response.json();
    const parsed = parseSpotifyTitle(raw?.title);
    const value = {
      title: parsed.title,
      artist: cleanText(raw?.author_name || raw?.author) || parsed.artist,
      spotify_url: trackUrl,
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
      title=CASE
        WHEN excluded.title IS NOT NULL AND excluded.title<>'' THEN excluded.title
        ELSE sh_track_metadata.title
      END,
      artist=CASE
        WHEN excluded.artist IS NOT NULL AND excluded.artist<>'' THEN excluded.artist
        ELSE sh_track_metadata.artist
      END,
      display_title=CASE
        WHEN excluded.display_title IS NOT NULL AND excluded.display_title<>'' THEN excluded.display_title
        ELSE sh_track_metadata.display_title
      END,
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

async function enrichMissingRows(rows, env) {
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
    const chunk = ids.slice(index, index + 6);
    const values = await Promise.all(chunk.map(async (id) => [id, await spotifyMetadata(id)]));
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

function mergeRows(rows) {
  const merged = new Map();
  for (const row of rows) {
    const title = bestText(row.title, row.raw_title, row.display_title, row.spotify_id, row.isrc) || '曲情報なし';
    const artist = bestText(row.artist, row.raw_artist);
    const resolved = title !== '曲情報なし' && !looksLikeId(title);
    const identity = resolved
      ? `name:${canonical(title)}|artist:${canonical(artist)}`
      : `id:${row.spotify_id || row.isrc || row.apple_music_id || row.stationhead_track_id || row.queue_track_id || row.position}`;
    const key = `${row.play_date}|${identity}`;
    const current = merged.get(key);
    if (!current) {
      merged.set(key, {
        play_date: row.play_date,
        track_key: identity,
        title,
        artist,
        spotify_url: row.spotify_url || null,
        play_count: 1,
        first_played_at: row.played_at,
        last_played_at: row.played_at,
        source_ids: [row.spotify_id, row.apple_music_id, row.isrc].filter(Boolean),
      });
      continue;
    }
    current.play_count += 1;
    current.first_played_at = Math.min(current.first_played_at, row.played_at);
    current.last_played_at = Math.max(current.last_played_at, row.played_at);
    if ((!current.artist || looksLikeId(current.artist)) && artist) current.artist = artist;
    if ((!current.title || looksLikeId(current.title)) && title) current.title = title;
    if (!current.spotify_url && row.spotify_url) current.spotify_url = row.spotify_url;
    for (const id of [row.spotify_id, row.apple_music_id, row.isrc]) {
      if (id && !current.source_ids.includes(id)) current.source_ids.push(id);
    }
  }
  return [...merged.values()].sort((a, b) =>
    b.play_date.localeCompare(a.play_date)
    || b.play_count - a.play_count
    || a.title.localeCompare(b.title, 'ja')
  );
}

export async function onRequestGet({ request, env }) {
  if (!env.DB) return out({ ok: false, error: 'DB binding missing' }, 500);
  const url = new URL(request.url);

  try {
    if (url.searchParams.get('latest') === '1') {
      const latest = await env.DB.prepare(`SELECT strftime('%Y-%m-%d', MAX(start_time) / 1000, 'unixepoch') AS play_date
        FROM sh_queue_items`).first();
      return out({ ok: true, latest_date: latest?.play_date || null, timezone: 'UTC' });
    }

    const from = valid(url.searchParams.get('from')) ? url.searchParams.get('from') : '2024-05-01';
    const to = valid(url.searchParams.get('to')) ? url.searchParams.get('to') : day();
    const fromTs = ts(from);
    const toTs = ts(to) + 86400000;
    const limit = Math.min(Math.max(+url.searchParams.get('limit') || 10000, 100), 20000);
    if (!Number.isFinite(fromTs) || !Number.isFinite(toTs) || toTs <= fromTs) {
      return out({ ok: false, error: 'invalid date range' }, 400);
    }

    const result = await env.DB.prepare(`WITH timed AS (
      SELECT q.*,
        q.start_time + COALESCE(SUM(COALESCE(q.duration_ms, 0)) OVER (
          PARTITION BY q.station_id, q.start_time
          ORDER BY q.position
          ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
        ), 0) AS played_at
      FROM sh_queue_items q
      WHERE q.start_time >= ? AND q.start_time < ?
    )
    SELECT
      strftime('%Y-%m-%d', p.played_at / 1000, 'unixepoch') AS play_date,
      p.played_at,
      p.position,
      p.queue_track_id,
      p.stationhead_track_id,
      p.spotify_id,
      p.apple_music_id,
      p.isrc,
      NULLIF(m.title, '') AS title,
      NULLIF(m.artist, '') AS artist,
      NULLIF(m.display_title, '') AS display_title,
      NULLIF(m.spotify_url, '') AS spotify_url,
      COALESCE(
        NULLIF(json_extract(p.raw_json, '$.track.title'), ''),
        NULLIF(json_extract(p.raw_json, '$.track.name'), ''),
        NULLIF(json_extract(p.raw_json, '$.title'), ''),
        NULLIF(json_extract(p.raw_json, '$.name'), '')
      ) AS raw_title,
      COALESCE(
        NULLIF(json_extract(p.raw_json, '$.track.artist_name'), ''),
        NULLIF(json_extract(p.raw_json, '$.track.artist'), ''),
        NULLIF(json_extract(p.raw_json, '$.track.artists[0].name'), ''),
        NULLIF(json_extract(p.raw_json, '$.artist_name'), ''),
        NULLIF(json_extract(p.raw_json, '$.artist'), ''),
        NULLIF(json_extract(p.raw_json, '$.artists[0].name'), '')
      ) AS raw_artist
    FROM timed p
    LEFT JOIN sh_track_metadata m ON m.spotify_id = p.spotify_id
    WHERE p.played_at >= ? AND p.played_at < ?
    ORDER BY p.played_at ASC
    LIMIT ?`).bind(fromTs - 604800000, toTs, fromTs, toTs, limit * 8 + 1).all();

    const enriched = await enrichMissingRows(result.results || [], env);
    const rows = mergeRows(enriched.rows);
    const truncated = rows.length > limit;
    return out({
      ok: true,
      mode: 'tracks',
      from,
      to,
      timezone: 'UTC',
      rows: truncated ? rows.slice(0, limit) : rows,
      truncated,
      metadata_persisted: enriched.persisted,
      method: 'queue_timeline_window_sum_spotify_metadata_d1_upsert_merge',
    });
  } catch (error) {
    if (/no such table|no such column|malformed JSON/i.test(String(error?.message || ''))) {
      return out({ ok: true, mode: 'tracks', rows: [], setup_required: true, timezone: 'UTC' });
    }
    return out({ ok: false, error: error?.message || 'track history error' }, 500);
  }
}
