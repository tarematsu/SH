const HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'public, max-age=300, s-maxage=900, stale-while-revalidate=3600',
};
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: HEADERS });
const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value || '');
const timestamp = (value) => Date.parse(`${value}T00:00:00Z`);

async function optionalRows(statement) {
  try {
    const result = await statement.all();
    return result.results || [];
  } catch (error) {
    if (/no such table/i.test(String(error?.message || ''))) return [];
    throw error;
  }
}

export async function onRequestGet({ request, env }) {
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500);
  const url = new URL(request.url);
  const from = validDate(url.searchParams.get('from')) ? url.searchParams.get('from') : '2024-05-01';
  const to = validDate(url.searchParams.get('to'))
    ? url.searchParams.get('to')
    : new Date().toISOString().slice(0, 10);
  const fromTs = timestamp(from);
  const toTs = timestamp(to) + 86400000;
  if (!Number.isFinite(fromTs) || !Number.isFinite(toTs) || toTs <= fromTs) {
    return json({ ok: false, error: 'invalid date range' }, 400);
  }

  try {
    const [realtime, queueRows, historical] = await Promise.all([
      optionalRows(env.DB.prepare(`SELECT
        strftime('%Y-%m-%d',observed_at/1000,'unixepoch') AS play_date,
        spotify_id,apple_music_id,isrc,stationhead_track_id,queue_track_id,
        NULL AS title,NULL AS artist,like_count,observed_at,source
        FROM sh_track_like_observations
        WHERE observed_at>=? AND observed_at<?
        ORDER BY observed_at ASC`).bind(fromTs, toTs)),
      optionalRows(env.DB.prepare(`SELECT
        strftime('%Y-%m-%d',q.start_time/1000,'unixepoch') AS play_date,
        q.spotify_id,q.apple_music_id,q.isrc,q.stationhead_track_id,q.queue_track_id,
        m.title,m.artist,q.bite_count AS like_count,q.observed_at,'queue' AS source
        FROM sh_queue_items q
        LEFT JOIN sh_track_metadata m ON m.spotify_id=q.spotify_id
        WHERE q.start_time>=? AND q.start_time<? AND q.bite_count IS NOT NULL
        ORDER BY q.observed_at ASC`).bind(fromTs, toTs)),
      optionalRows(env.DB.prepare(`SELECT
        strftime('%Y-%m-%d',observed_at/1000,'unixepoch') AS play_date,
        NULL AS spotify_id,NULL AS apple_music_id,NULL AS isrc,
        NULL AS stationhead_track_id,NULL AS queue_track_id,
        track_title AS title,artist,like_count,observed_at,'sheet' AS source
        FROM sh_track_like_history
        WHERE observed_at>=? AND observed_at<?
        ORDER BY observed_at ASC`).bind(fromTs, toTs)),
    ]);

    return json({ ok: true, from, to, rows: [...historical, ...queueRows, ...realtime] });
  } catch (error) {
    return json({ ok: false, error: error?.message || 'track likes error' }, 500);
  }
}
