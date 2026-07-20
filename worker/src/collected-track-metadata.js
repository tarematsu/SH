const QUEUE_STRUCTURAL_PAYLOAD = Symbol.for('stationhead.queue.structural-payload');
const QUEUE_LIKE_ANALYSIS = Symbol.for('stationhead.queue.like-analysis');

function integer(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function text(value, maximum = 2_048) {
  const normalized = String(value ?? '').trim();
  return normalized ? normalized.slice(0, maximum) : null;
}

export function normalizeCollectedIsrc(value) {
  const normalized = String(value ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(normalized) ? normalized : null;
}

function identityKey(isrc, spotifyId) {
  if (isrc) return `isrc:${isrc}`;
  return spotifyId ? `spotify:${spotifyId}` : null;
}

function metadataKey(value) {
  return identityKey(
    normalizeCollectedIsrc(value?.isrc),
    text(value?.spotify_id, 200),
  );
}

function mergeMetadata(current, next) {
  if (!current) return next;
  return {
    isrc: current.isrc || next.isrc || null,
    spotify_id: current.spotify_id || next.spotify_id || null,
    title: current.title || next.title || null,
    artist: current.artist || next.artist || null,
    thumbnail_url: current.thumbnail_url || next.thumbnail_url || null,
  };
}

function collectedMetadata(track, isrc, spotifyId) {
  const title = text(track?.title, 500);
  const artist = text(track?.artist, 500);
  const thumbnailUrl = text(track?.thumbnail_url);
  if (!isrc && !spotifyId) return null;
  return {
    isrc,
    spotify_id: isrc && title && artist && thumbnailUrl ? null : spotifyId,
    title,
    artist,
    thumbnail_url: thumbnailUrl,
  };
}

function compactTrack(track, isrc, spotifyId) {
  return {
    position: integer(track?.position),
    queue_track_id: integer(track?.queue_track_id),
    stationhead_track_id: integer(track?.stationhead_track_id),
    spotify_id: isrc ? null : spotifyId,
    isrc,
    duration_ms: integer(track?.duration_ms),
    bite_count: integer(track?.bite_count),
  };
}

function structuralTrack(track) {
  return {
    position: track.position,
    queue_track_id: track.queue_track_id,
    stationhead_track_id: track.stationhead_track_id,
    spotify_id: track.spotify_id,
    isrc: track.isrc,
    duration_ms: track.duration_ms,
  };
}

export function compactCollectedQueue(queue) {
  if (!queue || !Array.isArray(queue.tracks)) return { queue, metadata: [] };
  const trackCount = queue.tracks.length;
  const metadataByKey = new Map();
  const tracks = new Array(trackCount);
  const structuralTracks = new Array(trackCount);
  const likeValues = new Map();
  let identifiableLikes = 0;
  let completeLikes = true;

  for (let index = 0; index < trackCount; index += 1) {
    const source = queue.tracks[index];
    const isrc = normalizeCollectedIsrc(source?.isrc);
    const spotifyId = text(source?.spotify_id, 200);
    const key = identityKey(isrc, spotifyId);
    const compact = compactTrack(source, isrc, spotifyId);
    tracks[index] = compact;
    structuralTracks[index] = structuralTrack(compact);

    if (key) {
      identifiableLikes += 1;
      if (compact.bite_count == null) completeLikes = false;
      else likeValues.set(key, compact.bite_count);

      const row = collectedMetadata(source, isrc, spotifyId);
      if (row) metadataByKey.set(key, mergeMetadata(metadataByKey.get(key), row));
    }
  }

  const likePayload = new Array(likeValues.size);
  let likeIndex = 0;
  for (const [trackKey, likeCount] of likeValues) {
    likePayload[likeIndex] = { track_key: trackKey, like_count: likeCount };
    likeIndex += 1;
  }
  likePayload.sort((left, right) => left.track_key.localeCompare(right.track_key));

  const { tracks: _tracks, ...rest } = queue;
  const compact = { ...rest, tracks };
  const sourceStructural = queue[QUEUE_STRUCTURAL_PAYLOAD] || {};
  Object.defineProperty(compact, QUEUE_STRUCTURAL_PAYLOAD, {
    value: {
      station_id: integer(sourceStructural.station_id ?? compact.station_id),
      queue_id: integer(sourceStructural.queue_id ?? compact.queue_id),
      start_time: integer(sourceStructural.start_time ?? compact.start_time),
      is_paused: sourceStructural.is_paused ?? compact.is_paused ?? null,
      tracks: structuralTracks,
    },
  });
  Object.defineProperty(compact.tracks, QUEUE_LIKE_ANALYSIS, {
    value: {
      complete: identifiableLikes === 0 || completeLikes,
      payload: likePayload,
    },
  });
  return { queue: compact, metadata: [...metadataByKey.values()] };
}

export function metadataForCollectedQueue(metadata, queue) {
  if (!Array.isArray(metadata) || !Array.isArray(queue?.tracks)) return [];
  const wanted = new Set(queue.tracks.map(metadataKey).filter(Boolean));
  return metadata.filter((row) => wanted.has(metadataKey(row)));
}

export function attachCollectedTrackMetadata(queue, metadata) {
  if (!queue || !Array.isArray(queue.tracks) || !Array.isArray(metadata) || !metadata.length) return queue;
  const byKey = new Map(metadata.map((row) => [metadataKey(row), row]).filter(([key]) => key));
  return {
    ...queue,
    tracks: queue.tracks.map((track) => {
      const row = byKey.get(metadataKey(track));
      if (!row) return track;
      return {
        ...track,
        spotify_id: track.spotify_id || row.spotify_id || null,
        title: text(row.title, 500),
        artist: text(row.artist, 500),
        album_name: null,
        thumbnail_url: text(row.thumbnail_url),
      };
    }),
  };
}

function dictionaryStatement(db, row, observedAt) {
  return db.prepare(`INSERT INTO sh_track_dictionary(
      isrc,spotify_id,title,artist,thumbnail_url,
      metadata_source,metadata_fetched_at,updated_at
    ) VALUES(?,?,?,?,?,'stationhead_queue',?,?)
    ON CONFLICT(isrc) DO UPDATE SET
      spotify_id=COALESCE(sh_track_dictionary.spotify_id,excluded.spotify_id),
      title=COALESCE(sh_track_dictionary.title,excluded.title),
      artist=COALESCE(sh_track_dictionary.artist,excluded.artist),
      thumbnail_url=COALESCE(sh_track_dictionary.thumbnail_url,excluded.thumbnail_url),
      metadata_source=CASE
        WHEN sh_track_dictionary.title IS NULL
          OR sh_track_dictionary.artist IS NULL
          OR sh_track_dictionary.thumbnail_url IS NULL
        THEN excluded.metadata_source
        ELSE sh_track_dictionary.metadata_source
      END,
      metadata_fetched_at=MAX(sh_track_dictionary.metadata_fetched_at,excluded.metadata_fetched_at),
      updated_at=MAX(sh_track_dictionary.updated_at,excluded.updated_at)
    WHERE (sh_track_dictionary.spotify_id IS NULL AND excluded.spotify_id IS NOT NULL)
       OR (sh_track_dictionary.title IS NULL AND excluded.title IS NOT NULL)
       OR (sh_track_dictionary.artist IS NULL AND excluded.artist IS NOT NULL)
       OR (sh_track_dictionary.thumbnail_url IS NULL AND excluded.thumbnail_url IS NOT NULL)`)
    .bind(
      row.isrc,
      row.spotify_id,
      row.title,
      row.artist,
      row.thumbnail_url,
      observedAt,
      observedAt,
    );
}

export async function persistCollectedTrackMetadata(db, metadata, observedAt = Date.now()) {
  if (!db?.prepare || !Array.isArray(metadata)) return { attempted: 0, changed: 0 };
  const rows = metadata
    .map((row) => ({
      isrc: normalizeCollectedIsrc(row?.isrc),
      spotify_id: text(row?.spotify_id, 200),
      title: text(row?.title, 500),
      artist: text(row?.artist, 500),
      thumbnail_url: text(row?.thumbnail_url),
    }))
    .filter((row) => row.isrc && (row.spotify_id || row.title || row.artist || row.thumbnail_url));
  if (!rows.length) return { attempted: 0, changed: 0 };

  const statements = rows.map((row) => dictionaryStatement(db, row, integer(observedAt) ?? Date.now()));
  try {
    const results = typeof db.batch === 'function'
      ? await db.batch(statements)
      : await Promise.all(statements.map((statement) => statement.run()));
    return {
      attempted: rows.length,
      changed: (results || []).reduce((sum, result) => sum + Number(result?.meta?.changes || 0), 0),
    };
  } catch (error) {
    if (/no such table|no such column/i.test(String(error?.message || ''))) {
      return { attempted: rows.length, changed: 0, skipped: 'track-dictionary-schema-missing' };
    }
    throw error;
  }
}
