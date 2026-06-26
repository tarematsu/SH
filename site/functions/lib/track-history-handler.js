import { enrichMissingRows } from './track-history-metadata.js';
import { mergeTrackRows } from './track-history-merge.js';

const H = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'public, max-age=300, s-maxage=900, stale-while-revalidate=3600',
};
const out = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: H });
const day = () => new Date().toISOString().slice(0, 10);
const valid = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value || '');
const ts = (value) => Date.parse(`${value}T00:00:00Z`);

export async function handleTrackHistory({ request, env }) {
  if (!env.DB) return out({ ok: false, error: 'DB binding missing' }, 500);
  const url = new URL(request.url);
  try {
    if (url.searchParams.get('latest') === '1') {
      const latest = await env.DB.prepare(`SELECT strftime('%Y-%m-%d', MAX(observed_at) / 1000, 'unixepoch') AS play_date
        FROM sh_queue_snapshots`).first();
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

    const result = await env.DB.prepare(`WITH queue_seen AS (
      SELECT station_id, start_time, MAX(observed_at) AS queue_last_observed_at
      FROM sh_queue_snapshots
      WHERE start_time >= ? AND start_time < ?
      GROUP BY station_id, start_time
    ), timed AS (
      SELECT q.*,
        COALESCE(s.queue_last_observed_at, q.observed_at) AS queue_last_observed_at,
        q.start_time + COALESCE(SUM(COALESCE(q.duration_ms, 0)) OVER (
          PARTITION BY q.station_id, q.start_time ORDER BY q.position
          ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
        ), 0) AS played_at
      FROM sh_queue_items q
      LEFT JOIN queue_seen s
        ON s.station_id = q.station_id AND s.start_time = q.start_time
      WHERE q.start_time >= ? AND q.start_time < ?
    )
    SELECT
      strftime('%Y-%m-%d', p.played_at / 1000, 'unixepoch') AS play_date,
      p.played_at,p.position,p.queue_track_id,p.stationhead_track_id,
      p.spotify_id,p.apple_music_id,p.isrc,
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
      AND p.played_at <= p.queue_last_observed_at + 300000
    ORDER BY p.played_at ASC
    LIMIT ?`).bind(
      fromTs - 604800000, toTs,
      fromTs - 604800000, toTs,
      fromTs, toTs,
      limit * 8 + 1,
    ).all();

    const enriched = await enrichMissingRows(result.results || [], env);
    const rows = mergeTrackRows(enriched.rows);
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
      method: 'queue_snapshot_reached_tracks_spotify_metadata_d1_upsert_merge',
    });
  } catch (error) {
    if (/no such table|no such column|malformed JSON/i.test(String(error?.message || ''))) {
      return out({ ok: true, mode: 'tracks', rows: [], setup_required: true, timezone: 'UTC' });
    }
    return out({ ok: false, error: error?.message || 'track history error' }, 500);
  }
}
