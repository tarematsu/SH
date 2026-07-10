function normalizedIsrc(value) {
  if (value == null || value === '') return null;
  const isrc = String(value).trim().toUpperCase();
  return isrc || null;
}

function normalizedSpotifyId(value) {
  if (value == null || value === '') return null;
  const spotifyId = String(value).trim();
  return spotifyId || null;
}

function likeIdentity(row) {
  const isrc = normalizedIsrc(row?.isrc);
  if (isrc) return `isrc:${isrc}`;
  const spotifyId = normalizedSpotifyId(row?.spotify_id);
  return spotifyId ? `spotify:${spotifyId}` : null;
}

export const TRACK_LIKE_REALTIME_SQL = `WITH ranked AS (
  SELECT
    strftime('%Y-%m-%d',observed_at/1000,'unixepoch') AS play_date,
    spotify_id,apple_music_id,isrc,stationhead_track_id,queue_track_id,
    NULL AS title,NULL AS artist,like_count,observed_at,source,
    ROW_NUMBER() OVER (
      PARTITION BY
        strftime('%Y-%m-%d',observed_at/1000,'unixepoch'),
        CASE
          WHEN isrc IS NOT NULL AND TRIM(isrc)<>'' THEN 'isrc:'||UPPER(TRIM(isrc))
          ELSE 'spotify:'||TRIM(spotify_id)
        END
      ORDER BY observed_at DESC,id DESC
    ) AS row_rank
  FROM sh_track_like_observations
  WHERE observed_at>=? AND observed_at<?
    AND like_count IS NOT NULL
    AND (
      (isrc IS NOT NULL AND TRIM(isrc)<>'')
      OR (spotify_id IS NOT NULL AND TRIM(spotify_id)<>'')
    )
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
          WHEN q.isrc IS NOT NULL AND TRIM(q.isrc)<>'' THEN 'isrc:'||UPPER(TRIM(q.isrc))
          ELSE 'spotify:'||TRIM(q.spotify_id)
        END
      ORDER BY q.observed_at DESC,q.id DESC
    ) AS row_rank
  FROM sh_queue_items q
  LEFT JOIN sh_track_metadata m ON m.spotify_id=q.spotify_id
  WHERE q.start_time>=? AND q.start_time<?
    AND q.bite_count IS NOT NULL
    AND (
      (q.isrc IS NOT NULL AND TRIM(q.isrc)<>'')
      OR (q.spotify_id IS NOT NULL AND TRIM(q.spotify_id)<>'')
    )
)
SELECT play_date,spotify_id,apple_music_id,isrc,stationhead_track_id,queue_track_id,
  title,artist,like_count,observed_at,source
FROM ranked WHERE row_rank=1`;

export const TRACK_LIKE_HISTORY_SQL = `SELECT
  NULL AS play_date,NULL AS spotify_id,NULL AS apple_music_id,NULL AS isrc,
  NULL AS stationhead_track_id,NULL AS queue_track_id,
  NULL AS title,NULL AS artist,NULL AS like_count,NULL AS observed_at,
  'sheet' AS source
FROM sh_track_like_history WHERE 0`;

async function optionalRows(statement) {
  try {
    const result = await statement.all();
    return result.results || [];
  } catch (error) {
    if (/no such table|no such column/i.test(String(error?.message || ''))) return [];
    throw error;
  }
}

export function compactTrackLikeSources(sources) {
  const compact = new Map();
  for (const rows of sources || []) {
    for (const row of rows || []) {
      const identity = likeIdentity(row);
      if (!identity || !row?.play_date) continue;
      const key = `${row.play_date}|${identity}`;
      const previous = compact.get(key);
      if (!previous || Number(row?.observed_at || 0) >= Number(previous?.observed_at || 0)) {
        compact.set(key, {
          ...row,
          isrc: normalizedIsrc(row.isrc),
          spotify_id: normalizedSpotifyId(row.spotify_id),
        });
      }
    }
  }
  return [...compact.values()].sort((left, right) =>
    Number(left?.observed_at || 0) - Number(right?.observed_at || 0));
}

export function compactTrackLikeRows(rows) {
  return compactTrackLikeSources([rows]);
}

export function trackLikeStatements(db, fromTs, toTs) {
  return [db.prepare(TRACK_LIKE_REALTIME_SQL).bind(fromTs, toTs)];
}

export function compactTrackLikeBatchResults(results) {
  const [realtime] = results || [];
  return compactTrackLikeSources([realtime?.results || []]);
}

async function loadTrackLikeRowsFallback(db, fromTs, toTs) {
  const [realtime] = await Promise.all(
    trackLikeStatements(db, fromTs, toTs).map(optionalRows),
  );
  return [realtime];
}

export async function loadTrackLikeRows(db, fromTs, toTs) {
  let sources;
  if (typeof db.batch === 'function') {
    try {
      return compactTrackLikeBatchResults(await db.batch(trackLikeStatements(db, fromTs, toTs)));
    } catch (error) {
      if (!/no such table|no such column/i.test(String(error?.message || ''))) throw error;
      sources = await loadTrackLikeRowsFallback(db, fromTs, toTs);
    }
  } else {
    sources = await loadTrackLikeRowsFallback(db, fromTs, toTs);
  }
  return compactTrackLikeSources(sources);
}

function finiteLikeCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export function attachCompactTrackLikes(trackRows, compactRows) {
  const likes = new Map();
  for (const row of compactRows || []) {
    const identity = likeIdentity(row);
    if (!identity || !row?.play_date) continue;
    const mapKey = `${row.play_date}|${identity}`;
    const previous = likes.get(mapKey);
    if (!previous || Number(row?.observed_at || 0) >= Number(previous?.observed_at || 0)) {
      likes.set(mapKey, row);
    }
  }

  return (trackRows || []).map((row) => {
    let likeCount = finiteLikeCount(row?.like_count);
    const identity = likeIdentity(row);
    if (identity && row?.play_date) {
      const match = likes.get(`${row.play_date}|${identity}`);
      const value = finiteLikeCount(match?.like_count);
      if (value != null) likeCount = value;
    }
    return { ...row, like_count: likeCount };
  });
}

export function attachTrackLikes(trackRows, likeRows) {
  return attachCompactTrackLikes(trackRows, compactTrackLikeRows(likeRows));
}
