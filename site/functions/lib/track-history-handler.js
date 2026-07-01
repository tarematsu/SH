import { refreshMissingMetadata } from './track-history-metadata.js';
import { mergeTrackRows } from './track-history-merge.js';
import { attachCompactTrackLikes, loadTrackLikeRows } from './track-likes.js';

const H = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'public, max-age=300, s-maxage=900, stale-while-revalidate=3600',
};
const out = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: H });
const day = () => new Date().toISOString().slice(0, 10);
const valid = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value || '');
const ts = (value) => Date.parse(`${value}T00:00:00Z`);

export const TRACK_HISTORY_GRACE_MS = 5 * 60 * 1000;

export const TRACK_HISTORY_SQL = `WITH snapshot_evidence AS (
      SELECT station_id, start_time, MAX(observed_at) AS queue_last_observed_at
      FROM sh_queue_snapshots
      WHERE start_time IS NOT NULL
        AND start_time < ?
        AND observed_at >= ?
        AND COALESCE(is_paused, 0) = 0
      GROUP BY station_id, start_time
    ), item_evidence AS (
      SELECT q.station_id, q.start_time, MAX(q.observed_at) AS queue_last_observed_at
      FROM sh_queue_items q
      WHERE q.start_time < ?
        AND q.observed_at >= ?
        AND NOT EXISTS (
          SELECT 1 FROM sh_queue_snapshots s
          WHERE s.station_id = q.station_id AND s.start_time = q.start_time
        )
      GROUP BY q.station_id, q.start_time
    ), queue_evidence AS (
      SELECT station_id, start_time, queue_last_observed_at FROM snapshot_evidence
      UNION ALL
      SELECT station_id, start_time, queue_last_observed_at FROM item_evidence
    ), normalized AS (
      SELECT q.*, e.queue_last_observed_at,
        CASE
          WHEN q.duration_ms BETWEEN 1000 AND 21600000 THEN q.duration_ms
          ELSE NULL
        END AS normalized_duration_ms
      FROM sh_queue_items q
      JOIN queue_evidence e
        ON e.station_id = q.station_id AND e.start_time = q.start_time
      WHERE q.start_time < ?
    ), timed AS (
      SELECT n.*,
        n.start_time + COALESCE(SUM(n.normalized_duration_ms) OVER (
          PARTITION BY n.station_id, n.start_time ORDER BY n.position
          ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
        ), 0) AS played_at,
        COALESCE(SUM(CASE WHEN n.normalized_duration_ms IS NULL THEN 1 ELSE 0 END) OVER (
          PARTITION BY n.station_id, n.start_time ORDER BY n.position
          ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
        ), 0) AS invalid_durations_before
      FROM normalized n
    ), plays AS (
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
        AND p.invalid_durations_before = 0
        AND p.played_at <= p.queue_last_observed_at + ?
    )
    SELECT
      play_date,
      MIN(played_at) AS played_at,
      MIN(played_at) AS first_played_at,
      MAX(played_at) AS last_played_at,
      COUNT(*) AS play_count,
      MIN(position) AS position,
      MIN(queue_track_id) AS queue_track_id,
      stationhead_track_id,spotify_id,apple_music_id,isrc,
      MAX(title) AS title,MAX(artist) AS artist,
      MAX(display_title) AS display_title,MAX(spotify_url) AS spotify_url,
      MAX(raw_title) AS raw_title,MAX(raw_artist) AS raw_artist
    FROM plays
    GROUP BY
      play_date,stationhead_track_id,spotify_id,apple_music_id,isrc,
      CASE
        WHEN spotify_id IS NULL AND apple_music_id IS NULL AND isrc IS NULL
          AND stationhead_track_id IS NULL THEN queue_track_id
        ELSE NULL
      END,
      CASE
        WHEN spotify_id IS NULL AND apple_music_id IS NULL AND isrc IS NULL
          AND stationhead_track_id IS NULL AND queue_track_id IS NULL THEN position
        ELSE NULL
      END
    ORDER BY first_played_at ASC
    LIMIT ?`;

export async function handleTrackHistory({ request, env, waitUntil }) {
  if (!env.DB) return out({ ok: false, error: 'DB binding missing' }, 500);
  const url = new URL(request.url);
  try {
    if (url.searchParams.get('latest') === '1') {
      const latest = await env.DB.prepare(`SELECT strftime('%Y-%m-%d', MAX(observed_at) / 1000, 'unixepoch') AS play_date
        FROM sh_queue_snapshots WHERE COALESCE(is_paused, 0) = 0`).first();
      return out({ ok: true, latest_date: latest?.play_date || null, timezone: 'UTC' });
    }

    const from = valid(url.searchParams.get('from')) ? url.searchParams.get('from') : '2024-05-01';
    const to = valid(url.searchParams.get('to')) ? url.searchParams.get('to') : day();
    const fromTs = ts(from);
    const toTs = ts(to) + 86400000;
    const limit = Math.min(Math.max(+url.searchParams.get('limit') || 10000, 100), 20000);
    const includeLikes = url.searchParams.get('likes') === '1';
    if (!Number.isFinite(fromTs) || !Number.isFinite(toTs) || toTs <= fromTs) {
      return out({ ok: false, error: 'invalid date range' }, 400);
    }

    const maxGroupedRows = Math.min(limit * 8, 40000);
    const [result, likeRows] = await Promise.all([
      env.DB.prepare(TRACK_HISTORY_SQL).bind(
        toTs, fromTs - TRACK_HISTORY_GRACE_MS,
        toTs, fromTs - TRACK_HISTORY_GRACE_MS,
        toTs,
        fromTs, toTs,
        TRACK_HISTORY_GRACE_MS,
        maxGroupedRows + 1,
      ).all(),
      includeLikes ? loadTrackLikeRows(env.DB, fromTs, toTs) : Promise.resolve([]),
    ]);

    const allGroupedRows = result.results || [];
    const sourceTruncated = allGroupedRows.length > maxGroupedRows;
    const groupedRows = sourceTruncated ? allGroupedRows.slice(0, maxGroupedRows) : allGroupedRows;
    const mergedRows = mergeTrackRows(groupedRows);
    const rows = includeLikes ? attachCompactTrackLikes(mergedRows, likeRows) : mergedRows;
    const metadataRefreshScheduled = typeof waitUntil === 'function';
    if (metadataRefreshScheduled) {
      waitUntil(refreshMissingMetadata(groupedRows, env).catch((error) => {
        console.error('track metadata background refresh failed', error);
      }));
    }
    const truncated = sourceTruncated || rows.length > limit;
    return out({
      ok: true,
      mode: 'tracks',
      from,
      to,
      timezone: 'UTC',
      rows: rows.length > limit ? rows.slice(0, limit) : rows,
      truncated,
      source_truncated: sourceTruncated,
      source_row_count: groupedRows.reduce((sum, row) => sum + (Number(row.play_count) || 0), 0),
      grouped_row_count: groupedRows.length,
      likes_included: includeLikes,
      like_row_count: likeRows.length,
      metadata_refresh_scheduled: metadataRefreshScheduled,
      method: 'observed_unpaused_queue_reachability_utc_sql_preaggregate',
    });
  } catch (error) {
    if (/no such table|no such column|malformed JSON/i.test(String(error?.message || ''))) {
      return out({ ok: true, mode: 'tracks', rows: [], setup_required: true, timezone: 'UTC' });
    }
    return out({ ok: false, error: error?.message || 'track history error' }, 500);
  }
}
