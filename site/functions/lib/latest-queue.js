export const LATEST_QUEUE_WITH_ITEMS_SQL = `WITH latest_station AS (
  SELECT station_id FROM sh_channel_snapshots
  WHERE station_id IS NOT NULL ORDER BY observed_at DESC,id DESC LIMIT 1
), latest_queue AS (
  SELECT station_id,queue_id,start_time,is_paused,observed_at
  FROM sh_queue_snapshots
  WHERE station_id=(SELECT station_id FROM latest_station)
  ORDER BY observed_at DESC,id DESC LIMIT 1
)
SELECT lq.station_id AS queue_station_id,lq.queue_id,
  lq.start_time AS queue_start_time,lq.is_paused AS queue_is_paused,
  lq.observed_at AS queue_observed_at,q.observed_at AS item_observed_at,
  q.position,q.queue_track_id,q.stationhead_track_id,q.spotify_id,
  q.apple_music_id,q.deezer_id,q.isrc,q.duration_ms,q.preview_url,
  COALESCE(likes.like_count,q.bite_count) AS bite_count,
  m.title,m.artist,m.display_title,m.thumbnail_url,m.spotify_url,
  m.fetched_at AS metadata_fetched_at,m.raw_json AS metadata_raw_json
FROM latest_queue lq
LEFT JOIN sh_queue_items q ON q.station_id=lq.station_id AND q.start_time=lq.start_time
LEFT JOIN sh_track_metadata m ON m.spotify_id=q.spotify_id
LEFT JOIN sh_track_like_current likes ON likes.station_id IS q.station_id
  AND likes.track_key=COALESCE(CAST(q.queue_track_id AS TEXT),
    CAST(q.stationhead_track_id AS TEXT),q.spotify_id,q.isrc,
    'position:'||CAST(q.position AS TEXT))
ORDER BY q.position ASC LIMIT 80`;

export function parseLatestQueueRows(rows = []) {
  const head = rows[0];
  const latestQueue = head?.queue_start_time == null ? null : {
    station_id: head.queue_station_id, queue_id: head.queue_id,
    start_time: head.queue_start_time, is_paused: head.queue_is_paused,
    observed_at: head.queue_observed_at,
  };
  const queue = rows.filter((row) => row.position != null).map((row) => ({
    observed_at: row.item_observed_at, station_id: row.queue_station_id,
    queue_id: row.queue_id, start_time: row.queue_start_time, position: row.position,
    queue_track_id: row.queue_track_id, stationhead_track_id: row.stationhead_track_id,
    spotify_id: row.spotify_id, apple_music_id: row.apple_music_id,
    deezer_id: row.deezer_id, isrc: row.isrc, duration_ms: row.duration_ms,
    preview_url: row.preview_url, bite_count: row.bite_count, title: row.title,
    artist: row.artist, display_title: row.display_title,
    thumbnail_url: row.thumbnail_url, spotify_url: row.spotify_url,
    metadata_fetched_at: row.metadata_fetched_at,
    metadata_raw_json: row.metadata_raw_json,
  }));
  return { latestQueue, queue };
}
