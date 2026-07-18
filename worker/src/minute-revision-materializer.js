import {
  bool,
  integer,
} from './minute-facts-track-descriptor.js';
import {
  queueStructuralHash,
  queueStructurePayload,
  resolveLiveSession,
  timestampMs,
} from './minute-facts-store.js';
import {
  batchRun,
  resolveTracksBulk,
} from './minute-facts-track-resolution.js';
import { shouldStageLiveRevision } from './minute-revision-stages.js';

const DEFAULT_CHUNK_TRACKS = 3;

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = integer(value);
  if (parsed == null || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

function chunkTracks(env) {
  return positiveInteger(env?.DERIVE_REVISION_CHUNK_TRACKS, DEFAULT_CHUNK_TRACKS, 20);
}

export function shouldMaterializeLiveRevision(env, payload) {
  return shouldStageLiveRevision(env, payload);
}

export function preferredQueuePosition(queue, observedAt) {
  const tracks = Array.isArray(queue?.tracks) ? queue.tracks : [];
  if (!tracks.length) return 0;
  const explicit = integer(queue?.current_position);
  if (explicit != null) return Math.max(0, Math.min(tracks.length - 1, explicit));
  if (bool(queue?.is_paused) === 1) return 0;
  const startedAt = timestampMs(queue?.start_time);
  if (startedAt == null) return 0;
  const elapsed = Math.max(0, observedAt - startedAt);
  let offset = 0;
  for (let index = 0; index < tracks.length; index += 1) {
    const duration = integer(tracks[index]?.duration_ms);
    if (duration == null || duration <= 0) return Math.max(0, index - 1);
    if (elapsed < offset + duration) return index;
    offset += duration;
  }
  return tracks.length - 1;
}

async function findReusableRevision(db, input) {
  return db.prepare(`SELECT id,status,effective_at,item_count,materialized_item_count,
      coverage_complete,source_job_id,source_visible_count
    FROM sh_queue_revisions
    WHERE channel_id=? AND structural_hash=? AND session_id IS ? AND queue_start_time IS ?
      AND status IN ('complete','pending')
    ORDER BY CASE status WHEN 'complete' THEN 0 ELSE 1 END,effective_at DESC,id DESC
    LIMIT 1`)
    .bind(input.channelId, input.structuralHash, input.sessionId, input.queueStart)
    .first();
}

async function revisionProgress(db, revisionId) {
  const row = await db.prepare(
    'SELECT COUNT(*) AS item_count FROM sh_queue_revision_items WHERE revision_id=?',
  ).bind(revisionId).first();
  return Number(row?.item_count || 0);
}

function compactQueueIdentity(queue, totalCount) {
  return {
    station_id: integer(queue?.station_id),
    queue_id: integer(queue?.queue_id),
    start_time: timestampMs(queue?.start_time),
    total_track_count: totalCount,
    source_structural_hash: queue?.source_structural_hash ?? null,
  };
}

export async function prepareSparseLiveRevision(env, payload, options = {}, dependencies = {}) {
  const db = env?.MINUTE_DB;
  if (!db) throw new Error('minute revision materializer MINUTE_DB binding is missing');
  if (!shouldMaterializeLiveRevision(env, payload)) return { staged: false };

  const sourceJobId = integer(options.sourceJobId);
  if (sourceJobId == null) throw new Error('minute revision source job identity is missing');
  const snapshot = payload.snapshot || {};
  const queue = payload.queue || {};
  const observedAt = integer(payload.observedAt) ?? Date.now();
  const receivedAt = Date.now();
  const channelId = integer(snapshot.channel_id);
  if (channelId == null) throw new Error('minute revision channel identity is missing');
  const stationId = integer(snapshot.station_id ?? queue.station_id);
  const resolveSession = dependencies.resolveLiveSession || resolveLiveSession;
  const sessionId = await resolveSession(db, {
    channelId,
    stationId,
    hostId: null,
    broadcastStartTime: snapshot.broadcast_start_time,
    isBroadcasting: snapshot.is_broadcasting,
    observedAt,
  });
  const structure = queueStructurePayload(queue);
  const visibleCount = structure.tracks.length;
  const totalCount = Math.max(
    visibleCount,
    integer(queue.total_track_count) ?? visibleCount,
  );
  const structuralHash = await queueStructuralHash(queue, structure);
  const queueStart = timestampMs(queue.start_time);
  const findRevision = dependencies.findReusableRevision || findReusableRevision;
  let revision = await findRevision(db, {
    channelId,
    sessionId,
    queueStart,
    structuralHash,
  });

  if (!revision) {
    const insertRevision = dependencies.insertRevision || (async () => db.prepare(`INSERT OR IGNORE INTO sh_queue_revisions(
        session_id,channel_id,station_id,queue_id,queue_start_time,effective_at,received_at,
        structural_hash,item_count,status,source,source_priority,materialized_item_count,
        coverage_complete,source_job_id,source_visible_count,last_materialized_at
      ) VALUES(?,?,?,?,?,?,?,?,?,'pending','live_collector',100,0,0,?,?,NULL)`)
      .bind(
        sessionId,
        channelId,
        stationId,
        integer(queue.queue_id),
        queueStart,
        observedAt,
        receivedAt,
        structuralHash,
        totalCount,
        sourceJobId,
        visibleCount,
      )
      .run());
    await insertRevision();
    revision = await findRevision(db, {
      channelId,
      sessionId,
      queueStart,
      structuralHash,
    });
  }

  const revisionId = Number(revision?.id);
  if (!Number.isFinite(revisionId)) throw new Error('failed to create or resume sparse queue revision');
  const loadProgress = dependencies.revisionProgress || revisionProgress;
  const materializedCount = await loadProgress(db, revisionId);
  const updateSource = dependencies.updateRevisionSource || (async () => db.prepare(`UPDATE sh_queue_revisions SET
      item_count=MAX(item_count,?),source_job_id=?,
      source_visible_count=MAX(COALESCE(source_visible_count,0),?),
      materialized_item_count=?,coverage_complete=?,
      status=CASE WHEN ?>=? THEN 'complete' ELSE 'pending' END
    WHERE id=?`)
    .bind(
      totalCount,
      sourceJobId,
      visibleCount,
      materializedCount,
      materializedCount >= totalCount ? 1 : 0,
      materializedCount,
      visibleCount,
      revisionId,
    )
    .run());
  await updateSource();

  const preferredPosition = preferredQueuePosition(queue, observedAt);
  return {
    staged: materializedCount < visibleCount,
    sparse: true,
    revision_id: revisionId,
    source_job_id: sourceJobId,
    visible_item_count: visibleCount,
    total_item_count: totalCount,
    materialized_item_count: materializedCount,
    preferred_position: preferredPosition,
    enrichment: {
      channel_id: channelId,
      minute_at: Math.floor(observedAt / 60_000) * 60_000,
      observed_at: observedAt,
      station_id: stationId,
      provisional_session_id: sessionId,
      queue_start_time: queueStart,
      is_paused: bool(queue?.is_paused) === 1,
      host_account_id: snapshot.host_account_id ?? null,
      host_handle: snapshot.host_handle ?? null,
      broadcast_start_time: snapshot.broadcast_start_time ?? null,
      is_broadcasting: snapshot.is_broadcasting ?? null,
    },
    queue_identity: compactQueueIdentity(queue, totalCount),
  };
}

const SOURCE_TRACKS_SQL = `WITH raw AS (
    SELECT
      COALESCE(CAST(json_extract(track.value,'$.position') AS INTEGER),CAST(track.key AS INTEGER)) AS position,
      CAST(json_extract(track.value,'$.queue_track_id') AS INTEGER) AS queue_track_id,
      CAST(json_extract(track.value,'$.stationhead_track_id') AS INTEGER) AS stationhead_track_id,
      json_extract(track.value,'$.spotify_id') AS spotify_id,
      json_extract(track.value,'$.apple_music_id') AS apple_music_id,
      json_extract(track.value,'$.deezer_id') AS deezer_id,
      json_extract(track.value,'$.isrc') AS isrc,
      json_extract(track.value,'$.title') AS title,
      json_extract(track.value,'$.artist') AS artist,
      CAST(json_extract(track.value,'$.duration_ms') AS INTEGER) AS duration_ms,
      CAST(json_extract(track.value,'$.bite_count') AS INTEGER) AS bite_count
    FROM sh_minute_fact_jobs job,json_each(job.payload_json,'$.queue.tracks') track
    WHERE job.id=?
  ), scheduled AS (
    SELECT raw.*,
      COALESCE(SUM(CASE WHEN duration_ms>0 THEN duration_ms ELSE 0 END)
        OVER (ORDER BY position ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) AS playback_offset_ms,
      MIN(CASE WHEN duration_ms>0 THEN 1 ELSE 0 END)
        OVER (ORDER BY position ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS schedule_valid
    FROM raw
  )
  SELECT scheduled.* FROM scheduled
  LEFT JOIN sh_queue_revision_items item
    ON item.revision_id=? AND item.position=scheduled.position
  WHERE item.position IS NULL
  ORDER BY CASE scheduled.position
    WHEN ? THEN 0 WHEN ? THEN 1 WHEN ? THEN 2 ELSE 3 END,
    scheduled.position
  LIMIT ?`;

async function loadSourceTracks(db, state, limit) {
  const preferred = Math.max(0, integer(state.preferred_position) ?? 0);
  const result = await db.prepare(SOURCE_TRACKS_SQL)
    .bind(
      state.source_job_id,
      state.revision_id,
      preferred,
      preferred + 1,
      preferred + 2,
      limit,
    )
    .all();
  return result.results || [];
}

function validateState(value) {
  const revisionId = integer(value?.revision_id);
  const sourceJobId = integer(value?.source_job_id);
  const visibleItemCount = integer(value?.visible_item_count);
  const totalItemCount = integer(value?.total_item_count);
  if (revisionId == null || sourceJobId == null || visibleItemCount == null || totalItemCount == null) {
    throw new Error('invalid sparse queue revision state');
  }
  return {
    ...value,
    revision_id: revisionId,
    source_job_id: sourceJobId,
    visible_item_count: visibleItemCount,
    total_item_count: Math.max(visibleItemCount, totalItemCount),
    preferred_position: Math.max(0, integer(value.preferred_position) ?? 0),
  };
}

export async function writeSparseLiveRevisionChunk(env, revisionState, dependencies = {}) {
  const db = env?.MINUTE_DB;
  if (!db) throw new Error('minute revision materializer MINUTE_DB binding is missing');
  const state = validateState(revisionState);
  const load = dependencies.loadSourceTracks || loadSourceTracks;
  const sourceTracks = await load(db, state, chunkTracks(env));
  const observedAt = integer(state?.enrichment?.observed_at) ?? Date.now();
  const context = {
    channelId: integer(state?.enrichment?.channel_id),
    minuteAt: integer(state?.enrichment?.minute_at),
    queueTracks: state.visible_item_count,
    revisionId: state.revision_id,
  };
  const resolve = dependencies.resolveTracksBulk || resolveTracksBulk;
  const resolved = sourceTracks.length
    ? await resolve(db, env?.DB, sourceTracks, observedAt, context)
    : [];
  const byPosition = new Map(sourceTracks.map((track) => [integer(track.position), track]));
  const statements = resolved.map((track) => {
    const source = byPosition.get(integer(track.position)) || {};
    return db.prepare(`INSERT INTO sh_queue_revision_items(
        revision_id,position,track_id,queue_track_id,stationhead_track_id,isrc,spotify_id,
        deezer_id,duration_ms,playback_offset_ms,schedule_valid,bite_count
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(revision_id,position) DO UPDATE SET
        track_id=excluded.track_id,queue_track_id=excluded.queue_track_id,
        stationhead_track_id=excluded.stationhead_track_id,isrc=excluded.isrc,
        spotify_id=excluded.spotify_id,deezer_id=excluded.deezer_id,
        duration_ms=excluded.duration_ms,playback_offset_ms=excluded.playback_offset_ms,
        schedule_valid=excluded.schedule_valid,bite_count=excluded.bite_count`)
      .bind(
        state.revision_id,
        track.position,
        track.trackId,
        track.queue_track_id,
        track.stationhead_track_id,
        track.isrc,
        track.spotify_id,
        track.deezer_id,
        track.duration_ms,
        integer(source.playback_offset_ms),
        Number(source.schedule_valid || 0) === 1 ? 1 : 0,
        integer(source.bite_count),
      );
  });
  if (statements.length) await batchRun(db, statements);

  const countResult = dependencies.materializedCount
    ? await dependencies.materializedCount(db, state.revision_id)
    : await db.prepare('SELECT COUNT(*) AS item_count FROM sh_queue_revision_items WHERE revision_id=?')
      .bind(state.revision_id)
      .first();
  const materializedCount = Number(countResult?.item_count ?? countResult ?? 0);
  if (!sourceTracks.length && materializedCount < state.visible_item_count) {
    throw new Error(`queue revision ${state.revision_id} source payload is unavailable or incomplete`);
  }
  const visibleComplete = materializedCount >= state.visible_item_count;
  const coverageComplete = materializedCount >= state.total_item_count;
  const now = Date.now();
  const updateCoverage = dependencies.updateCoverage || (async () => db.prepare(`UPDATE sh_queue_revisions SET
      materialized_item_count=?,coverage_complete=?,last_materialized_at=?,
      status=CASE WHEN ?>=COALESCE(source_visible_count,?) THEN 'complete' ELSE 'pending' END
    WHERE id=?`)
    .bind(
      materializedCount,
      coverageComplete ? 1 : 0,
      now,
      materializedCount,
      state.visible_item_count,
      state.revision_id,
    )
    .run());
  await updateCoverage();

  const selectedPositions = new Set(sourceTracks.map((track) => integer(track.position)));
  return {
    ...state,
    complete: visibleComplete,
    coverage_complete: coverageComplete,
    materialized_item_count: materializedCount,
    chunk_tracks: sourceTracks.length,
    preferred_resolved: selectedPositions.has(state.preferred_position),
    source_tracks: sourceTracks,
  };
}
