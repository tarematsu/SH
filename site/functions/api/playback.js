import { json, num } from '../lib/api-utils.js';
import { parseLatestQueueRows } from '../lib/latest-queue.js';
import { computePlayback, normalizePlaybackTrack } from '../lib/playback.js';
import { hostIdentity, queueRevision, stateFromQueue } from '../lib/queue-state.js';

const CACHE_CONTROL = 'public, max-age=5, s-maxage=10, stale-while-revalidate=30';

export { computePlayback };

export const PLAYBACK_FEED_SQL = `WITH latest_channel AS (
  SELECT observed_at,station_id,is_broadcasting,host_account_id,host_handle,broadcast_start_time
  FROM sh_channel_snapshots
  ORDER BY observed_at DESC,id DESC
  LIMIT 1
), latest_queue AS (
  SELECT station_id,queue_id,start_time,is_paused,observed_at
  FROM sh_queue_snapshots
  WHERE station_id=(SELECT station_id FROM latest_channel)
  ORDER BY observed_at DESC,id DESC
  LIMIT 1
)
SELECT
  channel.observed_at AS channel_observed_at,
  channel.station_id AS channel_station_id,
  channel.is_broadcasting,channel.host_account_id,channel.host_handle,
  channel.broadcast_start_time,
  queue.station_id AS queue_station_id,queue.queue_id,
  queue.start_time AS queue_start_time,queue.is_paused AS queue_is_paused,
  queue.observed_at AS queue_observed_at,
  items.observed_at AS item_observed_at,
  items.position,items.queue_track_id,items.stationhead_track_id,items.spotify_id,
  items.apple_music_id,items.deezer_id,items.isrc,items.duration_ms,
  items.preview_url,items.bite_count,
  metadata.title,metadata.artist,metadata.display_title,metadata.thumbnail_url,
  metadata.spotify_url,metadata.fetched_at AS metadata_fetched_at,
  metadata.raw_json AS metadata_raw_json
FROM latest_channel channel
LEFT JOIN latest_queue queue ON 1=1
LEFT JOIN sh_queue_items items
  ON items.station_id=queue.station_id AND items.start_time=queue.start_time
LEFT JOIN sh_track_metadata metadata ON metadata.spotify_id=items.spotify_id
ORDER BY items.position ASC
LIMIT 80`;

export function parsePlaybackFeedRows(rows = []) {
  const head = rows[0] || null;
  const latest = head ? {
    observed_at: head.channel_observed_at,
    station_id: head.channel_station_id,
    is_broadcasting: head.is_broadcasting,
    host_account_id: head.host_account_id,
    host_handle: head.host_handle,
    broadcast_start_time: head.broadcast_start_time,
  } : null;
  const { latestQueue, queue } = parseLatestQueueRows(rows);
  return { latest, latestQueue, queue };
}

export async function onRequestGet({ env }) {
  const db = env.DB;
  if (!db) return json({ ok: false, error: 'DB binding missing' }, 500, 'no-store');

  try {
    const generatedAt = Date.now();
    const result = await db.prepare(PLAYBACK_FEED_SQL).all();
    const { latest, latestQueue, queue: rows } = parsePlaybackFeedRows(result.results || []);
    const revision = queueRevision(stateFromQueue(latestQueue, rows), hostIdentity(latest));

    if (!latestQueue) {
      return json({
        ok: true,
        generated_at: generatedAt,
        latest_observed_at: num(latest?.observed_at),
        station_id: num(latest?.station_id),
        is_broadcasting: Boolean(latest?.is_broadcasting),
        host_handle: latest?.host_handle || null,
        queue_revision: revision,
        queue_status: null,
        queue: [],
      }, 200, CACHE_CONTROL);
    }

    const playback = computePlayback(rows, generatedAt);
    const queue = rows.map((track, index) => normalizePlaybackTrack(track, index, playback));
    const paused = Boolean(latestQueue.is_paused);
    const broadcasting = latest?.is_broadcasting !== 0 && latest?.is_broadcasting !== false;
    const playing = broadcasting && !paused && playback.currentIndex >= 0;

    return json({
      ok: true,
      generated_at: generatedAt,
      latest_observed_at: num(latest?.observed_at),
      queue_observed_at: num(latestQueue.observed_at),
      station_id: num(latestQueue.station_id),
      is_broadcasting: broadcasting,
      host_account_id: num(latest?.host_account_id),
      host_handle: latest?.host_handle || null,
      broadcast_start_time: num(latest?.broadcast_start_time),
      playing,
      queue_revision: revision,
      queue_status: {
        queue_id: num(latestQueue.queue_id),
        start_time: num(latestQueue.start_time),
        is_paused: paused,
        playing,
        current_index: playback.currentIndex,
        progress_ms: playback.progressMs,
        anchor_at: playback.anchorAt,
        queue_end_at: playback.queueEndAt,
        total_items: queue.length,
      },
      queue,
    }, 200, CACHE_CONTROL);
  } catch (error) {
    console.error(error);
    return json({ ok: false, error: error?.message || 'playback feed error' }, 500, 'no-store');
  }
}
