import { bool, num, rawJson, text } from './api-utils.js';
import { splitD1Batches } from './d1-batch.js';
import {
  normalizedTrackIsrc,
  normalizedTrackSpotifyId,
  observationTrackKey,
  resetSnapshotHashCacheForTests,
  saveLeanSnapshot,
} from './d1-lean-ingest.js';
import { payloadHash } from './ingest-claim.js';
import {
  commitQueueStructurePersistence,
  prepareQueueStructurePersistence,
} from '../../../worker/src/persist-structure-stages.js';

const QUEUE_LIKE_ANALYSIS = Symbol.for('stationhead.queue.like-analysis');
const WRITE_BATCH_SIZE = 30;
export const D1_BATCH_STATEMENT_LIMIT = 40;
export const D1_BATCH_VARIABLE_LIMIT = 90;
export const D1_SINGLE_STATEMENT_VARIABLE_LIMIT = 90;

export { saveLeanSnapshot, splitD1Batches };

export function resetQueueHashCacheForTests() {
  resetSnapshotHashCacheForTests();
}

export function analyzeQueueLikes(tracks) {
  if (tracks?.[QUEUE_LIKE_ANALYSIS]) return tracks[QUEUE_LIKE_ANALYSIS];
  const unique = new Map();
  let identifiable = 0;
  let complete = true;
  for (const track of Array.isArray(tracks) ? tracks : []) {
    const trackKey = observationTrackKey(track);
    if (!trackKey) continue;
    identifiable += 1;
    const likeCount = num(track?.bite_count);
    if (likeCount == null) {
      complete = false;
      continue;
    }
    unique.set(trackKey, likeCount);
  }
  return {
    complete: identifiable === 0 || complete,
    payload: [...unique.entries()]
      .map(([trackKey, likeCount]) => ({ track_key: trackKey, like_count: likeCount }))
      .sort((left, right) => left.track_key.localeCompare(right.track_key)),
  };
}

export function queueLikesPayload(tracks) {
  return analyzeQueueLikes(tracks).payload;
}

export function hasCompleteLikeSnapshot(tracks) {
  return analyzeQueueLikes(tracks).complete;
}

async function runBatches(db, statements) {
  for (let index = 0; index < statements.length; index += WRITE_BATCH_SIZE) {
    const batch = statements.slice(index, index + WRITE_BATCH_SIZE);
    if (batch.length) await db.batch(batch);
  }
}

function likeEntries(tracks) {
  const entries = new Map();
  for (const track of Array.isArray(tracks) ? tracks : []) {
    const trackKey = observationTrackKey(track);
    const likeCount = num(track?.bite_count);
    if (!trackKey || likeCount == null) continue;
    entries.set(trackKey, { trackKey, likeCount, track });
  }
  return [...entries.values()];
}

function pruneCurrentLikesStatement(db, stationId, keys, observedAt) {
  if (!keys.length) {
    return db.prepare(`DELETE FROM sh_track_like_current
      WHERE station_id IS ? AND ?>=COALESCE((
        SELECT MAX(observed_at) FROM sh_queue_snapshots WHERE station_id IS ?
      ),0)`).bind(stationId, observedAt, stationId);
  }
  if (keys.length + 3 > D1_SINGLE_STATEMENT_VARIABLE_LIMIT) return null;
  const placeholders = keys.map(() => '?').join(',');
  return db.prepare(`DELETE FROM sh_track_like_current
    WHERE station_id IS ? AND track_key NOT IN (${placeholders})
      AND ?>=COALESCE((
        SELECT MAX(observed_at) FROM sh_queue_snapshots WHERE station_id IS ?
      ),0)`).bind(stationId, ...keys, observedAt, stationId);
}

function likeStatements(db, entries, observedAt, stationId, queueId, startTime) {
  const statements = [];
  for (const { trackKey, likeCount, track } of entries) {
    const position = num(track?.position);
    statements.push(
      db.prepare(`UPDATE sh_queue_items SET bite_count=?
        WHERE station_id IS ? AND start_time IS ? AND position IS ?
          AND bite_count IS NOT ?`)
        .bind(likeCount, stationId, startTime, position, likeCount),
      db.prepare(`INSERT INTO sh_track_like_current (
          station_id,track_key,queue_id,start_time,position,queue_track_id,
          stationhead_track_id,spotify_id,isrc,like_count,observed_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(station_id,track_key) DO UPDATE SET
          queue_id=excluded.queue_id,start_time=excluded.start_time,position=excluded.position,
          queue_track_id=excluded.queue_track_id,
          stationhead_track_id=excluded.stationhead_track_id,
          spotify_id=excluded.spotify_id,isrc=excluded.isrc,
          like_count=excluded.like_count,observed_at=excluded.observed_at
        WHERE excluded.observed_at>=sh_track_like_current.observed_at
          AND excluded.like_count IS NOT sh_track_like_current.like_count`)
        .bind(
          stationId, trackKey, queueId, startTime, position,
          num(track?.queue_track_id), num(track?.stationhead_track_id),
          normalizedTrackSpotifyId(track), normalizedTrackIsrc(track), likeCount, observedAt,
        ),
      db.prepare(`INSERT INTO sh_track_like_observations (
          observed_at,station_id,queue_id,start_time,position,queue_track_id,
          stationhead_track_id,spotify_id,isrc,track_key,like_count,source,raw_json
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(observed_at,station_id,track_key) DO UPDATE SET
          queue_id=excluded.queue_id,start_time=excluded.start_time,position=excluded.position,
          queue_track_id=excluded.queue_track_id,
          stationhead_track_id=excluded.stationhead_track_id,
          spotify_id=excluded.spotify_id,isrc=excluded.isrc,
          like_count=excluded.like_count,source=excluded.source,raw_json=excluded.raw_json`)
        .bind(
          observedAt, stationId, queueId, startTime, position,
          num(track?.queue_track_id), num(track?.stationhead_track_id),
          normalizedTrackSpotifyId(track), normalizedTrackIsrc(track),
          trackKey, likeCount, 'collector', rawJson({ bite_count: likeCount }),
        ),
    );
  }
  return statements;
}

async function persistLikes(db, body, observedAt) {
  const data = body?.data || {};
  const tracks = Array.isArray(data.tracks) ? data.tracks : [];
  const analysis = analyzeQueueLikes(tracks);
  if (!analysis.complete) return { likesChanged: false, completeLikes: false, observationsWritten: 0 };

  const stationId = num(data.station_id);
  const queueId = num(data.queue_id);
  const startTime = num(data.start_time);
  const likesHash = await payloadHash(analysis.payload);
  const current = await db.prepare(`SELECT likes_hash,observed_at
    FROM sh_queue_current WHERE station_id IS ? LIMIT 1`).bind(stationId).first();
  if (current?.likes_hash === likesHash) {
    return { likesChanged: false, completeLikes: true, observationsWritten: 0 };
  }
  if (Number(current?.observed_at || 0) > observedAt) {
    return { likesChanged: false, completeLikes: true, observationsWritten: 0, staleCurrent: true };
  }

  const entries = likeEntries(tracks);
  const statements = [];
  const prune = pruneCurrentLikesStatement(db, stationId, entries.map((entry) => entry.trackKey), observedAt);
  if (prune) statements.push(prune);
  statements.push(...likeStatements(db, entries, observedAt, stationId, queueId, startTime));
  statements.push(db.prepare(`UPDATE sh_queue_current SET
      likes_hash=?,is_paused=?,observed_at=MAX(observed_at,?),updated_at=?
    WHERE station_id IS ?`)
    .bind(likesHash, bool(data.is_paused), observedAt, Date.now(), stationId));
  await runBatches(db, statements);
  return {
    likesChanged: true,
    completeLikes: true,
    observationsWritten: entries.length,
  };
}

export async function saveLeanQueue(db, observedAt, body) {
  const plan = await prepareQueueStructurePersistence(db, body, observedAt);
  const structure = await commitQueueStructurePersistence(db, body, observedAt, plan);
  const likes = await persistLikes(db, body, observedAt);
  return {
    ...structure,
    ...likes,
    claim: structure.claim || plan.claim,
    inspected: structure.inspected || likes.likesChanged,
    itemsWritten: Number(structure.itemsWritten || 0),
    currentLikeMigrationsWritten: 0,
    staleCurrent: structure.staleCurrent || likes.staleCurrent || false,
  };
}

function stableHeartbeatMetadata(data) {
  const metadata = { ...(data || {}) };
  for (const key of [
    'collector_id', 'hostname', 'version', 'observed_at', 'last_seen_at',
    'heartbeat_at', 'timestamp', 'sent_at', 'now',
  ]) delete metadata[key];
  return metadata;
}

export async function saveLeanHeartbeat(db, observedAt, data) {
  const result = await db.prepare(`INSERT INTO sh_collector_heartbeats (
      collector_id,first_seen_at,last_seen_at,hostname,version,metadata_json
    ) VALUES (?,?,?,?,?,?)
    ON CONFLICT(collector_id) DO UPDATE SET
      last_seen_at=excluded.last_seen_at,hostname=excluded.hostname,
      version=excluded.version,metadata_json=excluded.metadata_json
    WHERE excluded.last_seen_at>=sh_collector_heartbeats.last_seen_at
      AND (
        excluded.last_seen_at-sh_collector_heartbeats.last_seen_at>=600000
        OR excluded.hostname IS NOT sh_collector_heartbeats.hostname
        OR excluded.version IS NOT sh_collector_heartbeats.version
        OR excluded.metadata_json IS NOT sh_collector_heartbeats.metadata_json
      )`)
    .bind(
      text(data?.collector_id), observedAt, observedAt,
      text(data?.hostname), text(data?.version), rawJson(stableHeartbeatMetadata(data)),
    ).run();
  return { accepted: Number(result?.meta?.changes || 0) > 0 };
}
