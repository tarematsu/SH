export const LATEST_QUEUE_STATE_SQL = `WITH latest_queue AS (
  SELECT station_id,queue_id,start_time,is_paused,observed_at
  FROM sh_queue_snapshots
  WHERE station_id=?
  ORDER BY observed_at DESC,id DESC
  LIMIT 1
)
SELECT
  lq.station_id AS queue_station_id,
  lq.queue_id,
  lq.start_time AS queue_start_time,
  lq.is_paused AS queue_is_paused,
  lq.observed_at AS queue_observed_at,
  MAX(q.observed_at) AS item_observed_at,
  MAX(m.fetched_at) AS metadata_fetched_at,
  COUNT(q.position) AS total_items
FROM latest_queue lq
LEFT JOIN sh_queue_items q
  ON q.station_id=lq.station_id AND q.start_time=lq.start_time
LEFT JOIN sh_track_metadata m ON m.spotify_id=q.spotify_id
GROUP BY lq.station_id,lq.queue_id,lq.start_time,lq.is_paused,lq.observed_at`;

export const QUEUE_ITEMS_FOR_STATE_SQL = `SELECT
  q.observed_at AS item_observed_at,
  q.position,q.queue_track_id,q.stationhead_track_id,q.spotify_id,
  q.apple_music_id,q.deezer_id,q.isrc,q.duration_ms,q.preview_url,q.bite_count,
  m.title,m.artist,m.display_title,m.thumbnail_url,m.spotify_url,
  m.fetched_at AS metadata_fetched_at,m.raw_json AS metadata_raw_json
FROM sh_queue_items q
LEFT JOIN sh_track_metadata m ON m.spotify_id=q.spotify_id
WHERE q.station_id=? AND q.start_time=?
ORDER BY q.position ASC
LIMIT 80`;

function maximum(rows, key) {
  let result = null;
  for (const row of rows || []) {
    const value = Number(row?.[key]);
    if (Number.isFinite(value)) result = result == null ? value : Math.max(result, value);
  }
  return result;
}

export function parseQueueState(row) {
  if (row?.queue_start_time == null) return null;
  return {
    station_id: row.queue_station_id,
    queue_id: row.queue_id,
    start_time: row.queue_start_time,
    is_paused: row.queue_is_paused,
    observed_at: row.queue_observed_at,
    item_observed_at: row.item_observed_at ?? null,
    metadata_fetched_at: row.metadata_fetched_at ?? null,
    total_items: Number(row.total_items || 0),
  };
}

export function queueRevision(state, hostIdentity = '') {
  const queuePart = state ? [
    state.station_id ?? '', state.queue_id ?? '', state.start_time ?? '',
    state.is_paused ? 1 : 0, state.item_observed_at ?? 0,
    state.metadata_fetched_at ?? 0, state.total_items ?? 0,
  ].join(':') : 'none';
  return `${queuePart}:${hostIdentity || ''}`;
}

export function stateFromQueue(latestQueue, queue = []) {
  if (!latestQueue) return null;
  return {
    ...latestQueue,
    item_observed_at: maximum(queue, 'observed_at'),
    metadata_fetched_at: maximum(queue, 'metadata_fetched_at'),
    total_items: queue.length,
  };
}

export function queueItemsFromRows(rows = [], state = null) {
  if (!state) return [];
  return rows.filter((row) => row.position != null).map((row) => ({
    observed_at: row.item_observed_at,
    station_id: state.station_id,
    queue_id: state.queue_id,
    start_time: state.start_time,
    position: row.position,
    queue_track_id: row.queue_track_id,
    stationhead_track_id: row.stationhead_track_id,
    spotify_id: row.spotify_id,
    apple_music_id: row.apple_music_id,
    deezer_id: row.deezer_id,
    isrc: row.isrc,
    duration_ms: row.duration_ms,
    preview_url: row.preview_url,
    bite_count: row.bite_count,
    title: row.title,
    artist: row.artist,
    display_title: row.display_title,
    thumbnail_url: row.thumbnail_url,
    spotify_url: row.spotify_url,
    metadata_fetched_at: row.metadata_fetched_at,
    metadata_raw_json: row.metadata_raw_json,
  }));
}
