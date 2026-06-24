const H = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'public, max-age=60, s-maxage=300',
};
const out = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: H });
const day = () => new Date(Date.now() + 32400000).toISOString().slice(0, 10);
const valid = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value || '');
const ts = (value) => Date.parse(`${value}T00:00:00+09:00`);

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
  const songLyrics = cleaned.match(/^(.*?)\s*-\s*song and lyrics by\s*(.+)$/i);
  if (songLyrics) return { title: cleanText(songLyrics[1]), artist: cleanText(songLyrics[2]) };
  return { title: cleaned, artist: null };
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) return null;
  return response.json().catch(() => null);
}

async function resolveExternal(row) {
  if (row.apple_music_id) {
    for (const country of ['JP', 'US']) {
      const params = new URLSearchParams({ id: String(row.apple_music_id), entity: 'song', country });
      const raw = await fetchJson(`https://itunes.apple.com/lookup?${params}`);
      const item = raw?.results?.find((value) => value.kind === 'song' && value.trackName && value.artistName)
        || raw?.results?.find((value) => value.trackName && value.artistName);
      if (item) return { title: item.trackName, artist: item.artistName, source: `apple_${country}` };
    }
  }

  if (row.spotify_id) {
    const spotifyUrl = `https://open.spotify.com/track/${encodeURIComponent(row.spotify_id)}`;
    const raw = await fetchJson(`https://open.spotify.com/oembed?url=${encodeURIComponent(spotifyUrl)}`);
    if (raw?.title) {
      const parsed = parseSpotifyTitle(raw.title);
      return {
        title: parsed.title,
        artist: cleanText(raw.author_name || raw.author) || parsed.artist,
        spotify_url: spotifyUrl,
        source: 'spotify_oembed',
      };
    }
  }
  return null;
}

function needsExternal(row) {
  const title = bestText(row.title, row.raw_title, row.display_title);
  const artist = bestText(row.artist, row.raw_artist);
  return !title || looksLikeId(title) || !artist || looksLikeId(artist);
}

async function enrichRows(rows) {
  const targets = new Map();
  for (const row of rows) {
    if (!needsExternal(row)) continue;
    const key = `${row.spotify_id || ''}|${row.apple_music_id || ''}`;
    if (key !== '|') targets.set(key, row);
    if (targets.size >= 40) break;
  }

  const resolved = new Map();
  const entries = [...targets.entries()];
  for (let i = 0; i < entries.length; i += 4) {
    const chunk = entries.slice(i, i + 4);
    const values = await Promise.all(chunk.map(async ([key, row]) => [key, await resolveExternal(row)]));
    for (const [key, value] of values) if (value) resolved.set(key, value);
  }

  return rows.map((row) => {
    const key = `${row.spotify_id || ''}|${row.apple_music_id || ''}`;
    const value = resolved.get(key);
    if (!value) return row;
    return {
      ...row,
      title: bestText(value.title, row.title, row.raw_title, row.display_title),
      artist: bestText(value.artist, row.artist, row.raw_artist),
      spotify_url: row.spotify_url || value.spotify_url || null,
      metadata_source: value.source,
    };
  });
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
  const from = valid(url.searchParams.get('from')) ? url.searchParams.get('from') : '2024-05-01';
  const to = valid(url.searchParams.get('to')) ? url.searchParams.get('to') : day();
  const fromTs = ts(from);
  const toTs = ts(to) + 86400000;
  const limit = Math.min(Math.max(+url.searchParams.get('limit') || 10000, 100), 20000);
  if (!Number.isFinite(fromTs) || !Number.isFinite(toTs) || toTs <= fromTs) {
    return out({ ok: false, error: 'invalid date range' }, 400);
  }

  try {
    const result = await env.DB.prepare(`WITH p AS (
      SELECT q.*,
        q.start_time + COALESCE((
          SELECT SUM(COALESCE(x.duration_ms, 0))
          FROM sh_queue_items x
          WHERE x.station_id = q.station_id
            AND x.start_time = q.start_time
            AND x.position < q.position
        ), 0) AS played_at
      FROM sh_queue_items q
      WHERE q.start_time >= ? AND q.start_time < ?
    )
    SELECT
      strftime('%Y-%m-%d', p.played_at / 1000, 'unixepoch', '+9 hours') AS play_date,
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
    FROM p
    LEFT JOIN sh_track_metadata m ON m.spotify_id = p.spotify_id
    WHERE p.played_at >= ? AND p.played_at < ?
    ORDER BY p.played_at ASC
    LIMIT ?`).bind(fromTs - 604800000, toTs, fromTs, toTs, limit * 8 + 1).all();

    const sourceRows = await enrichRows(result.results || []);
    const rows = mergeRows(sourceRows);
    const truncated = rows.length > limit;
    return out({
      ok: true,
      mode: 'tracks',
      from,
      to,
      rows: truncated ? rows.slice(0, limit) : rows,
      truncated,
      method: 'queue_timeline_title_artist_merge_with_external_backfill',
    });
  } catch (error) {
    if (/no such table|no such column|malformed JSON/i.test(String(error?.message || ''))) {
      return out({ ok: true, mode: 'tracks', from, to, rows: [], setup_required: true });
    }
    return out({ ok: false, error: error?.message || 'track history error' }, 500);
  }
}
