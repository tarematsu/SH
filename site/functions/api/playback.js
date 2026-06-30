import { json, num } from '../lib/api-utils.js';
import { computePlayback, normalizePlaybackTrack } from '../lib/playback.js';

const CACHE_CONTROL = 'public, max-age=5, s-maxage=10, stale-while-revalidate=30';

export { computePlayback };

export async function onRequestGet({ env }) {
  const db = env.DB;
  if (!db) return json({ ok: false, error: 'DB binding missing' }, 500, 'no-store');

  try {
    const generatedAt = Date.now();
    const [latest, latestQueue] = await Promise.all([
      db.prepare(`SELECT observed_at,station_id,is_broadcasting,host_account_id,host_handle,broadcast_start_time
        FROM sh_channel_snapshots ORDER BY observed_at DESC,id DESC LIMIT 1`).first(),
      db.prepare(`SELECT station_id,queue_id,start_time,is_paused,observed_at
        FROM sh_queue_snapshots ORDER BY observed_at DESC,id DESC LIMIT 1`).first(),
    ]);

    if (!latestQueue) {
      return json({
        ok: true,
        generated_at: generatedAt,
        latest_observed_at: num(latest?.observed_at),
        station_id: num(latest?.station_id),
        is_broadcasting: Boolean(latest?.is_broadcasting),
        host_handle: latest?.host_handle || null,
        queue_status: null,
        queue: [],
      }, 200, CACHE_CONTROL);
    }

    const result = await db.prepare(`SELECT q.position,q.queue_track_id,q.stationhead_track_id,q.spotify_id,q.isrc,
      q.duration_ms,m.title,m.artist,m.display_title,m.thumbnail_url,m.spotify_url,
      m.fetched_at AS metadata_fetched_at,m.raw_json AS metadata_raw_json
      FROM sh_queue_items q LEFT JOIN sh_track_metadata m ON m.spotify_id=q.spotify_id
      WHERE q.station_id=? AND q.start_time=? ORDER BY q.position ASC LIMIT 80`)
      .bind(latestQueue.station_id, latestQueue.start_time).all();

    const rows = result.results || [];
    const queueForPlayback = rows.map((track) => ({ ...track, start_time: latestQueue.start_time }));
    const playback = computePlayback(queueForPlayback, generatedAt);
    const queue = rows.map((track, index) => (
      normalizePlaybackTrack({ ...track, start_time: latestQueue.start_time }, index, playback)
    ));
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
      queue_revision: `${latestQueue.station_id || ''}:${latestQueue.queue_id || ''}:${latestQueue.start_time || ''}`,
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
