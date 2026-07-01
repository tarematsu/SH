import { canonical } from './track-history-text.js';

const idValue = (value) => value == null || value === '' ? null : String(value);

export const TRACK_LIKE_REALTIME_SQL = `WITH ranked AS (
  SELECT
    strftime('%Y-%m-%d',observed_at/1000,'unixepoch') AS play_date,
    spotify_id,apple_music_id,isrc,stationhead_track_id,queue_track_id,
    NULL AS title,NULL AS artist,like_count,observed_at,source,
    ROW_NUMBER() OVER (
      PARTITION BY
        strftime('%Y-%m-%d',observed_at/1000,'unixepoch'),
        CASE
          WHEN spotify_id IS NOT NULL AND spotify_id<>'' THEN 'spotify:'||spotify_id
          WHEN apple_music_id IS NOT NULL AND apple_music_id<>'' THEN 'apple:'||apple_music_id
          WHEN isrc IS NOT NULL AND isrc<>'' THEN 'isrc:'||isrc
          WHEN stationhead_track_id IS NOT NULL THEN 'stationhead:'||stationhead_track_id
          WHEN queue_track_id IS NOT NULL THEN 'queue:'||queue_track_id
          ELSE 'track:'||COALESCE(track_key,'')
        END
      ORDER BY observed_at DESC,id DESC
    ) AS row_rank
  FROM sh_track_like_observations
  WHERE observed_at>=? AND observed_at<? AND like_count IS NOT NULL
)
SELECT play_date,spotify_id,apple_music_id,isrc,stationhead_track_id,queue_track_id,
  title,artist,like_count,observed_at,source
FROM ranked WHERE row_rank=1`;

export const TRACK_LIKE_QUEUE_SQL = `WITH ranked AS (
  SELECT
    strftime('%Y-%m-%d',q.start_time/1000,'unixepoch') AS play_date,
    q.spotify_id,q.apple_music_id,q.isrc,q.stationhead_track_id,q.queue_track_id,
    m.title,m.artist,q.bite_count AS like_count,q.observed_at,'queue' AS source,
    ROW_NUMBER() OVER (
      PARTITION BY
        strftime('%Y-%m-%d',q.start_time/1000,'unixepoch'),
        CASE
          WHEN q.spotify_id IS NOT NULL AND q.spotify_id<>'' THEN 'spotify:'||q.spotify_id
          WHEN q.apple_music_id IS NOT NULL AND q.apple_music_id<>'' THEN 'apple:'||q.apple_music_id
          WHEN q.isrc IS NOT NULL AND q.isrc<>'' THEN 'isrc:'||q.isrc
          WHEN q.stationhead_track_id IS NOT NULL THEN 'stationhead:'||q.stationhead_track_id
          WHEN q.queue_track_id IS NOT NULL THEN 'queue:'||q.queue_track_id
          ELSE 'position:'||q.position
        END
      ORDER BY q.observed_at DESC,q.id DESC
    ) AS row_rank
  FROM sh_queue_items q
  LEFT JOIN sh_track_metadata m ON m.spotify_id=q.spotify_id
  WHERE q.start_time>=? AND q.start_time<? AND q.bite_count IS NOT NULL
)
SELECT play_date,spotify_id,apple_music_id,isrc,stationhead_track_id,queue_track_id,
  title,artist,like_count,observed_at,source
FROM ranked WHERE row_rank=1`;

export const TRACK_LIKE_HISTORY_SQL = `WITH ranked AS (
  SELECT
    strftime('%Y-%m-%d',observed_at/1000,'unixepoch') AS play_date,
    NULL AS spotify_id,NULL AS apple_music_id,NULL AS isrc,
    NULL AS stationhead_track_id,NULL AS queue_track_id,
    track_title AS title,artist,like_count,observed_at,'sheet' AS source,
    ROW_NUMBER() OVER (
      PARTITION BY strftime('%Y-%m-%d',observed_at/1000,'unixepoch'),track_title,artist
      ORDER BY observed_at DESC
    ) AS row_rank
  FROM sh_track_like_history
  WHERE observed_at>=? AND observed_at<? AND like_count IS NOT NULL
)
SELECT play_date,spotify_id,apple_music_id,isrc,stationhead_track_id,queue_track_id,
  title,artist,like_count,observed_at,source
FROM ranked WHERE row_rank=1`;

async function optionalRows(statement) {
  try {
    const result = await statement.all();
    return result.results || [];
  } catch (error) {
    if (/no such table|no such column/i.test(String(error?.message || ''))) return [];
    throw error;
  }
}

function primaryIdentity(row) {
  const spotify = idValue(row?.spotify_id);
  if (spotify) return `spotify:${spotify}`;
  const apple = idValue(row?.apple_music_id);
  if (apple) return `apple:${apple}`;
  const isrc = idValue(row?.isrc);
  if (isrc) return `isrc:${isrc}`;
  const stationhead = idValue(row?.stationhead_track_id);
  if (stationhead) return `stationhead:${stationhead}`;
  const queue = idValue(row?.queue_track_id);
  if (queue) return `queue:${queue}`;
  if (row?.title) return `name:${canonical(row.title)}|artist:${canonical(row.artist)}`;
  return `unknown:${row?.source || ''}:${row?.observed_at || ''}`;
}

export function compactTrackLikeRows(rows) {
  const compact = new Map();
  for (const row of rows || []) {
    const key = `${row?.play_date || ''}|${primaryIdentity(row)}`;
    const previous = compact.get(key);
    if (!previous || Number(row?.observed_at || 0) >= Number(previous?.observed_at || 0)) compact.set(key, row);
  }
  return [...compact.values()].sort((a, b) => Number(a?.observed_at || 0) - Number(b?.observed_at || 0));
}

export async function loadTrackLikeRows(db, fromTs, toTs) {
  const [realtime, queue, historical] = await Promise.all([
    optionalRows(db.prepare(TRACK_LIKE_REALTIME_SQL).bind(fromTs, toTs)),
    optionalRows(db.prepare(TRACK_LIKE_QUEUE_SQL).bind(fromTs, toTs)),
    optionalRows(db.prepare(TRACK_LIKE_HISTORY_SQL).bind(fromTs, toTs)),
  ]);
  return compactTrackLikeRows([...historical, ...queue, ...realtime]);
}

function identityKeys(row) {
  const keys = [];
  const addId = (value) => {
    const id = idValue(value);
    if (id) keys.push(`id:${id}`);
  };
  for (const value of row?.source_ids || []) addId(value);
  for (const key of ['spotify_id', 'apple_music_id', 'isrc', 'stationhead_track_id', 'queue_track_id']) addId(row?.[key]);
  if (row?.title) keys.push(`name:${canonical(row.title)}|artist:${canonical(row.artist)}`);
  if (row?.title) keys.push(`name:${canonical(row.title)}`);
  return [...new Set(keys)];
}

export function attachTrackLikes(trackRows, likeRows) {
  const likes = new Map();
  for (const row of compactTrackLikeRows(likeRows)) {
    for (const key of identityKeys(row)) likes.set(`${row.play_date}|${key}`, row.like_count);
  }
  return (trackRows || []).map((row) => {
    let likeCount = null;
    for (const key of identityKeys(row)) {
      const value = likes.get(`${row.play_date}|${key}`);
      if (value != null) {
        likeCount = Number(value);
        break;
      }
    }
    return { ...row, like_count: Number.isFinite(likeCount) ? likeCount : null };
  });
}
