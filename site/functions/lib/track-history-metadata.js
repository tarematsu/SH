import { fetchSpotifyMetadataBatch } from './spotify-metadata.js';
import { bestText, looksLikeId } from './track-history-text.js';

function normalizedSpotifyId(value) {
  return String(value || '').trim() || null;
}

function normalizedIsrc(value) {
  return String(value || '').trim().toUpperCase() || null;
}

export function metadataIdentityBySpotifyId(rows = []) {
  const identities = new Map();
  for (const row of rows) {
    const spotifyId = normalizedSpotifyId(row?.spotify_id);
    if (!spotifyId) continue;
    const isrc = normalizedIsrc(row?.isrc);
    if (isrc || !identities.has(spotifyId)) identities.set(spotifyId, isrc);
  }
  return identities;
}

async function persistResolvedMetadata(env, resolved, identities = new Map()) {
  if (!resolved.size) return 0;
  const now = Date.now();
  const statements = [...resolved.entries()].map(([spotifyId, value]) => env.DB.prepare(`
    INSERT INTO sh_track_metadata (
      spotify_id,isrc,title,artist,display_title,spotify_url,fetched_at,raw_json
    ) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(spotify_id) DO UPDATE SET
      isrc=COALESCE(excluded.isrc,sh_track_metadata.isrc),
      title=CASE WHEN excluded.title IS NOT NULL AND excluded.title<>'' THEN excluded.title ELSE sh_track_metadata.title END,
      artist=CASE WHEN excluded.artist IS NOT NULL AND excluded.artist<>'' THEN excluded.artist ELSE sh_track_metadata.artist END,
      display_title=CASE WHEN excluded.display_title IS NOT NULL AND excluded.display_title<>'' THEN excluded.display_title ELSE sh_track_metadata.display_title END,
      spotify_url=COALESCE(excluded.spotify_url,sh_track_metadata.spotify_url),
      fetched_at=excluded.fetched_at,
      raw_json=excluded.raw_json
  `).bind(
    spotifyId,
    identities.get(spotifyId) || null,
    value.title || null,
    value.artist || null,
    value.title && value.artist ? `${value.title} — ${value.artist}` : value.title || null,
    value.spotify_url || null,
    now,
    JSON.stringify({
      source: 'spotify_oembed',
      spotify: value.raw || null,
      isrc: identities.get(spotifyId) || null,
    }),
  ));
  await env.DB.batch(statements);
  return statements.length;
}

function unresolvedSpotifyIds(rows, limit = 20) {
  const ids = new Set();
  for (const row of rows) {
    const title = bestText(row.title, row.raw_title, row.display_title);
    const artist = bestText(row.artist, row.raw_artist);
    const spotifyId = normalizedSpotifyId(row?.spotify_id);
    if ((!title || looksLikeId(title) || !artist || looksLikeId(artist)) && spotifyId) {
      ids.add(spotifyId);
      if (ids.size >= limit) break;
    }
  }
  return [...ids];
}

async function resolveMissingMetadata(rows, env) {
  const ids = unresolvedSpotifyIds(rows);
  if (!ids.length) return { resolved: new Map(), persisted: 0 };

  const resolved = await fetchSpotifyMetadataBatch(ids);
  const identities = metadataIdentityBySpotifyId(rows);

  let persisted = 0;
  try {
    persisted = await persistResolvedMetadata(env, resolved, identities);
  } catch (error) {
    console.error('track metadata D1 upsert failed', error);
  }
  return { resolved, persisted };
}

export async function refreshMissingMetadata(rows, env) {
  const { persisted } = await resolveMissingMetadata(rows, env);
  return persisted;
}

export async function enrichMissingRows(rows, env) {
  const { resolved, persisted } = await resolveMissingMetadata(rows, env);
  if (!resolved.size) return { rows, persisted };
  return {
    persisted,
    rows: rows.map((row) => {
      const value = resolved.get(normalizedSpotifyId(row?.spotify_id));
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
