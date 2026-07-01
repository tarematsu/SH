import { json } from '../lib/api-utils.js';
import { fetchSpotifyMetadataBatch } from '../lib/spotify-metadata.js';

const CACHE_CONTROL = 'no-store';
const EMPTY_RESULT_TTL_MS = 60 * 1000;
const refreshState = {
  pending: null,
  emptyUntil: 0,
};

export function completeMetadataCount(resolved) {
  let count = 0;
  for (const [spotifyId, value] of resolved.entries()) {
    const title = String(value?.title || '').trim();
    const artist = String(value?.artist || '').trim();
    if (title && artist && title !== spotifyId && artist !== spotifyId) count += 1;
  }
  return count;
}

async function performTrackMetadataRefresh(env) {
  const result = await env.DB.prepare(`WITH missing AS (
    SELECT q.spotify_id,MAX(q.observed_at) AS latest_observed_at
    FROM sh_queue_items q
    LEFT JOIN sh_track_metadata m ON m.spotify_id=q.spotify_id
    WHERE q.spotify_id IS NOT NULL AND q.spotify_id<>''
      AND (
        m.spotify_id IS NULL
        OR m.title IS NULL OR m.title='' OR m.title=q.spotify_id
        OR m.artist IS NULL OR m.artist='' OR m.artist=q.spotify_id
      )
    GROUP BY q.spotify_id
  )
  SELECT spotify_id,COUNT(*) OVER () AS total_missing
  FROM missing
  ORDER BY latest_observed_at DESC
  LIMIT 25`).all();

  const rows = result.results || [];
  const ids = rows.map((row) => row.spotify_id).filter(Boolean);
  const totalMissing = Number(rows[0]?.total_missing || 0);
  if (!ids.length) {
    return { ok: true, processed: 0, updated: 0, remaining: 0, done: true };
  }

  const resolved = await fetchSpotifyMetadataBatch(ids);
  if (resolved.size) {
    const now = Date.now();
    await env.DB.batch([...resolved.entries()].map(([spotifyId, value]) => env.DB.prepare(`
      INSERT INTO sh_track_metadata (
        spotify_id,title,artist,display_title,spotify_url,source,fetched_at,raw_json
      ) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(spotify_id) DO UPDATE SET
        title=CASE WHEN excluded.title IS NOT NULL AND excluded.title<>'' THEN excluded.title ELSE sh_track_metadata.title END,
        artist=CASE WHEN excluded.artist IS NOT NULL AND excluded.artist<>'' THEN excluded.artist ELSE sh_track_metadata.artist END,
        display_title=CASE WHEN excluded.display_title IS NOT NULL AND excluded.display_title<>'' THEN excluded.display_title ELSE sh_track_metadata.display_title END,
        spotify_url=COALESCE(excluded.spotify_url,sh_track_metadata.spotify_url),
        source=excluded.source,fetched_at=excluded.fetched_at,raw_json=excluded.raw_json
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

  const remainingCount = Math.max(0, totalMissing - completeMetadataCount(resolved));
  return {
    ok: true,
    processed: ids.length,
    updated: resolved.size,
    remaining: remainingCount,
    done: remainingCount === 0,
  };
}

export async function refreshTrackMetadata(env, now = Date.now()) {
  if (refreshState.emptyUntil > now) {
    return {
      ok: true,
      processed: 0,
      updated: 0,
      remaining: 0,
      done: true,
      cached: true,
    };
  }
  if (refreshState.pending) return refreshState.pending;

  refreshState.pending = performTrackMetadataRefresh(env).then((result) => {
    refreshState.emptyUntil = result.processed === 0 && result.done
      ? Date.now() + EMPTY_RESULT_TTL_MS
      : 0;
    return result;
  }).catch((error) => {
    refreshState.emptyUntil = 0;
    throw error;
  }).finally(() => {
    refreshState.pending = null;
  });
  return refreshState.pending;
}

export function resetTrackMetadataRefreshState() {
  refreshState.pending = null;
  refreshState.emptyUntil = 0;
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500, CACHE_CONTROL);
  const url = new URL(request.url);
  const origin = request.headers.get('origin');
  if (origin && origin !== url.origin) return json({ ok: false, error: 'forbidden' }, 403, CACHE_CONTROL);

  try {
    return json(await refreshTrackMetadata(env), 200, CACHE_CONTROL);
  } catch (error) {
    return json({ ok: false, error: error?.message || 'metadata refresh failed' }, 500, CACHE_CONTROL);
  }
}
