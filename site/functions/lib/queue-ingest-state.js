import { num, rawJson, text } from './api-utils.js';

const QUERY_CHUNK = 80;
const CHECKPOINT_MS = 60 * 60 * 1000;

export const D1_BATCH_STATEMENT_LIMIT = 40;
export const D1_BATCH_VARIABLE_LIMIT = 800;

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function statementBindCount(statement) {
  return Array.isArray(statement?.params) ? statement.params.length : 0;
}

export function splitD1Batches(statements) {
  const groups = [];
  let current = [];
  let bindCount = 0;
  for (const statement of Array.isArray(statements) ? statements : []) {
    const nextBindCount = statementBindCount(statement);
    if (current.length > 0 && (
      current.length >= D1_BATCH_STATEMENT_LIMIT
      || bindCount + nextBindCount > D1_BATCH_VARIABLE_LIMIT
    )) {
      groups.push(current);
      current = [];
      bindCount = 0;
    }
    current.push(statement);
    bindCount += nextBindCount;
  }
  if (current.length) groups.push(current);
  return groups;
}

function observationTrackKey(track) {
  return text(track?.queue_track_id)
    || text(track?.stationhead_track_id)
    || text(track?.spotify_id)
    || text(track?.isrc)
    || `position:${num(track?.position) ?? -1}`;
}

export function latestLikesSql(count) {
  const placeholders = Array.from({ length: count }, () => '?').join(',');
  return `WITH ranked AS (
    SELECT track_key,observed_at,like_count,
      ROW_NUMBER() OVER (PARTITION BY track_key ORDER BY observed_at DESC,id DESC) AS row_rank
    FROM sh_track_like_observations
    WHERE station_id IS ? AND track_key IN (${placeholders})
  ) SELECT track_key,observed_at,like_count FROM ranked WHERE row_rank=1`;
}

export function planLikeObservations(tracks, latestRows, _observedAt) {
  const latest = new Map((latestRows || []).map((row) => [String(row.track_key), row]));
  const unique = new Map();
  for (const track of Array.isArray(tracks) ? tracks : []) {
    if (num(track?.bite_count) == null) continue;
    unique.set(observationTrackKey(track), track);
  }
  return [...unique.entries()]
    .filter(([trackKey, track]) => {
      const previous = latest.get(trackKey);
      return !previous || num(previous.like_count) !== num(track.bite_count);
    })
    .map(([trackKey, track]) => ({ trackKey, track }));
}

function queueItemState(track, queueId = null) {
  return {
    queue_id: num(queueId ?? track.queue_id),
    queue_track_id: num(track.queue_track_id),
    stationhead_track_id: num(track.stationhead_track_id),
    spotify_id: text(track.spotify_id),
    deezer_id: text(track.deezer_id),
    isrc: text(track.isrc),
    duration_ms: num(track.duration_ms),
    preview_url: text(track.preview_url),
    bite_count: num(track.bite_count),
    raw_json: rawJson({
      queue_id: num(queueId ?? track.queue_id),
      queue_track_id: num(track.queue_track_id),
      stationhead_track_id: num(track.stationhead_track_id),
      spotify_id: text(track.spotify_id),
      deezer_id: text(track.deezer_id),
      isrc: text(track.isrc),
      duration_ms: num(track.duration_ms),
      preview_url: text(track.preview_url),
    }),
  };
}

function sameValue(left, right) {
  return (left ?? null) === (right ?? null);
}

export function queueItemsToWrite(tracks, existingRows, _observedAt, queueId = null) {
  const existing = new Map((existingRows || []).map((row) => [Number(row.position), row]));
  const unique = new Map();
  for (const track of Array.isArray(tracks) ? tracks : []) {
    const position = num(track.position);
    if (position != null) unique.set(position, track);
  }

  const changed = [];
  for (const track of unique.values()) {
    const previous = existing.get(num(track.position));
    if (!previous) {
      changed.push(track);
      continue;
    }
    const current = queueItemState(track, queueId);
    if (Object.entries(current).some(([key, value]) => key !== 'raw_json' && !sameValue(previous[key], value))) {
      changed.push(track);
    }
  }
  return changed;
}

function queueItemLookupStatements(db, stationId, startTime, positions) {
  return chunks(positions, QUERY_CHUNK).filter((group) => group.length).map((group) => {
    const placeholders = group.map(() => '?').join(',');
    return db.prepare(`SELECT
      position,observed_at,queue_id,queue_track_id,stationhead_track_id,
      spotify_id,deezer_id,isrc,duration_ms,preview_url,bite_count,raw_json
      FROM sh_queue_items
      WHERE station_id IS ? AND start_time IS ? AND position IN (${placeholders})`)
      .bind(stationId, startTime, ...group);
  });
}

function latestLikeLookupStatements(db, stationId, trackKeys) {
  return chunks(trackKeys, QUERY_CHUNK).filter((group) => group.length)
    .map((group) => db.prepare(latestLikesSql(group.length)).bind(stationId, ...group));
}

export async function loadQueueComparisonState(db, stationId, startTime, positions, trackKeys) {
  const itemStatements = queueItemLookupStatements(db, stationId, startTime, positions);
  const likeStatements = latestLikeLookupStatements(db, stationId, trackKeys);
  const statements = itemStatements.concat(likeStatements);
  if (!statements.length) return { existingRows: [], latestRows: [], statementCount: 0 };

  const results = typeof db.batch === 'function'
    ? await db.batch(statements)
    : await Promise.all(statements.map((statement) => statement.all()));
  const itemResults = results.slice(0, itemStatements.length);
  const likeResults = results.slice(itemStatements.length);
  return {
    existingRows: itemResults.flatMap((result) => result?.results || []),
    latestRows: likeResults.flatMap((result) => result?.results || []),
    statementCount: statements.length,
  };
}

export const QUEUE_INSPECTION_STATE_SQL = `SELECT snapshots.raw_json,
  (SELECT MAX(items.observed_at) FROM sh_queue_items items
    WHERE items.station_id IS ? AND items.start_time IS ?) AS item_observed_at
FROM sh_queue_snapshots snapshots
WHERE snapshots.station_id IS ? AND snapshots.start_time IS ?
ORDER BY snapshots.observed_at DESC,snapshots.id DESC
LIMIT 1`;

export function queueInspectionDue(previous, payloadJson, observedAt) {
  if (!previous || previous.raw_json !== payloadJson) return true;
  const itemObservedAt = num(previous.item_observed_at);
  return itemObservedAt == null || observedAt - itemObservedAt >= CHECKPOINT_MS;
}
