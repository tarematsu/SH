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

const DEFAULT_STAGE_THRESHOLD = 12;
const DEFAULT_CHUNK_TRACKS = 5;

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = integer(value);
  if (parsed == null || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

function stageThreshold(env) {
  return positiveInteger(env?.DERIVE_REVISION_STAGE_TRACKS, DEFAULT_STAGE_THRESHOLD, 200);
}

function chunkTracks(env) {
  return positiveInteger(env?.DERIVE_REVISION_CHUNK_TRACKS, DEFAULT_CHUNK_TRACKS, 20);
}

export function shouldStageLiveRevision(env, payload) {
  return !payload?.rebuild
    && bool(payload?.snapshot?.is_broadcasting) !== 0
    && Array.isArray(payload?.queue?.tracks)
    && payload.queue.tracks.length >= stageThreshold(env);
}

async function findReusableRevision(db, input) {
  return db.prepare(`SELECT id,status,effective_at,item_count FROM sh_queue_revisions
    WHERE channel_id=? AND structural_hash=? AND session_id IS ? AND queue_start_time IS ?
      AND status IN ('complete','pending')
    ORDER BY CASE status WHEN 'complete' THEN 0 ELSE 1 END,effective_at DESC,id DESC
    LIMIT 1`)
    .bind(input.channelId, input.structuralHash, input.sessionId, input.queueStart)
    .first();
}

async function revisionProgress(db, revisionId) {
  const row = await db.prepare(`SELECT COUNT(*) AS item_count,MAX(position) AS max_position,
      MAX(CASE WHEN schedule_valid=1 THEN playback_offset_ms+duration_ms END) AS playback_end,
      MIN(schedule_valid) AS schedule_valid
    FROM sh_queue_revision_items WHERE revision_id=?`)
    .bind(revisionId)
    .first();
  const count = Number(row?.item_count || 0);
  const maxPosition = integer(row?.max_position);
  if (count > 0 && maxPosition !== count - 1) {
    throw new Error(`queue revision ${revisionId} has non-contiguous materialization: ${count}/${maxPosition}`);
  }
  return {
    cursor: count,
    playbackOffset: integer(row?.playback_end) ?? 0,
    scheduleValid: count === 0 || Number(row?.schedule_valid || 0) === 1,
  };
}

export async function prepareLiveRevisionStage(env, payload) {
  const db = env?.MINUTE_DB;
  if (!db) throw new Error('minute revision stage MINUTE_DB binding is missing');
  if (!shouldStageLiveRevision(env, payload)) return { staged: false };

  const snapshot = payload.snapshot || {};
  const queue = payload.queue || {};
  const observedAt = integer(payload.observedAt) ?? Date.now();
  const receivedAt = Date.now();
  const channelId = integer(snapshot.channel_id);
  if (channelId == null) throw new Error('minute revision stage channel identity is missing');
  const stationId = integer(snapshot.station_id ?? queue.station_id);
  const sessionId = await resolveLiveSession(db, {
    channelId,
    stationId,
    hostId: null,
    broadcastStartTime: snapshot.broadcast_start_time,
    isBroadcasting: snapshot.is_broadcasting,
    observedAt,
  });
  const structure = queueStructurePayload(queue);
  const targetCount = structure.tracks.length;
  const structuralHash = await queueStructuralHash(queue, structure);
  const queueStart = timestampMs(queue.start_time);
  let revision = await findReusableRevision(db, {
    channelId,
    sessionId,
    queueStart,
    structuralHash,
  });

  if (!revision) {
    await db.prepare(`INSERT OR IGNORE INTO sh_queue_revisions(
        session_id,channel_id,station_id,queue_id,queue_start_time,effective_at,received_at,
        structural_hash,item_count,status,source,source_priority
      ) VALUES(?,?,?,?,?,?,?,?,?,'pending','live_collector',100)`)
      .bind(
        sessionId,
        channelId,
        stationId,
        integer(queue.queue_id),
        queueStart,
        observedAt,
        receivedAt,
        structuralHash,
        targetCount,
      )
      .run();
    revision = await findReusableRevision(db, {
      channelId,
      sessionId,
      queueStart,
      structuralHash,
    });
  }

  const revisionId = Number(revision?.id);
  if (!Number.isFinite(revisionId)) throw new Error('failed to create or resume staged queue revision');
  const progress = await revisionProgress(db, revisionId);
  if (progress.cursor >= targetCount) {
    return {
      staged: false,
      complete: true,
      revision_id: revisionId,
      materialized_count: progress.cursor,
    };
  }

  return {
    staged: true,
    complete: false,
    revision_id: revisionId,
    channel_id: channelId,
    minute_at: Math.floor(observedAt / 60_000) * 60_000,
    cursor: progress.cursor,
    playback_offset_ms: progress.playbackOffset,
    schedule_valid: progress.scheduleValid,
    item_count: targetCount,
    total_item_count: Math.max(
      targetCount,
      integer(queue.total_track_count) ?? targetCount,
    ),
  };
}

function validateRevisionState(state, payload) {
  const revisionId = integer(state?.revision_id);
  const cursor = integer(state?.cursor) ?? 0;
  const itemCount = integer(state?.item_count);
  const queueTracks = Array.isArray(payload?.queue?.tracks) ? payload.queue.tracks : null;
  if (revisionId == null || cursor < 0 || itemCount == null || !queueTracks || itemCount !== queueTracks.length) {
    throw new Error('invalid staged queue revision state');
  }
  return {
    revisionId,
    cursor,
    itemCount,
    totalItemCount: Math.max(
      itemCount,
      integer(state.total_item_count) ?? integer(payload?.queue?.total_track_count) ?? itemCount,
    ),
    playbackOffset: integer(state.playback_offset_ms) ?? 0,
    scheduleValid: state.schedule_valid !== false,
  };
}

export async function writeLiveRevisionChunk(env, payload, revisionState) {
  const db = env?.MINUTE_DB;
  if (!db) throw new Error('minute revision stage MINUTE_DB binding is missing');
  const state = validateRevisionState(revisionState, payload);
  const queue = payload.queue;
  const observedAt = integer(payload.observedAt) ?? Date.now();
  const structure = queueStructurePayload(queue);
  const end = Math.min(state.itemCount, state.cursor + chunkTracks(env));
  const sourceTracks = structure.tracks.slice(state.cursor, end);
  const context = {
    channelId: integer(payload?.snapshot?.channel_id),
    minuteAt: Math.floor(observedAt / 60_000) * 60_000,
    queueTracks: state.itemCount,
    revisionId: state.revisionId,
  };
  const resolved = await resolveTracksBulk(db, env?.DB, sourceTracks, observedAt, context);
  let playbackOffset = state.playbackOffset;
  let scheduleValid = state.scheduleValid;
  const scheduled = resolved.map((track) => {
    const duration = integer(track.duration_ms);
    const validItem = scheduleValid && duration != null && duration > 0;
    const result = {
      ...track,
      playbackOffset: scheduleValid ? playbackOffset : null,
      scheduleValid: validItem,
    };
    if (validItem) playbackOffset += duration;
    else scheduleValid = false;
    return result;
  });
  const byPosition = new Map((queue.tracks || []).map((track, index) => [
    integer(track?.position) ?? index,
    track,
  ]));
  const statements = scheduled.map((track) => db.prepare(`INSERT INTO sh_queue_revision_items(
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
      state.revisionId,
      track.position,
      track.trackId,
      track.queue_track_id,
      track.stationhead_track_id,
      track.isrc,
      track.spotify_id,
      track.deezer_id,
      track.duration_ms,
      track.playbackOffset,
      track.scheduleValid ? 1 : 0,
      integer(byPosition.get(track.position)?.bite_count),
    ));
  if (statements.length) await batchRun(db, statements);
  return {
    ...revisionState,
    cursor: end,
    playback_offset_ms: playbackOffset,
    schedule_valid: scheduleValid,
    complete: end >= state.itemCount,
    chunk_tracks: sourceTracks.length,
  };
}

async function markRevisionCoverage(db, revisionId, materializedCount, totalCount) {
  const coverageComplete = materializedCount >= totalCount ? 1 : 0;
  try {
    await db.prepare(`UPDATE sh_queue_revisions SET
        item_count=MAX(item_count,?),total_item_count=MAX(COALESCE(total_item_count,0),?),
        coverage_complete=?,status='complete'
      WHERE id=?`)
      .bind(materializedCount, totalCount, coverageComplete, revisionId)
      .run();
  } catch (error) {
    if (!/no such column/i.test(String(error?.message || ''))) throw error;
    await db.prepare("UPDATE sh_queue_revisions SET item_count=MAX(item_count,?),status='complete' WHERE id=?")
      .bind(materializedCount, revisionId)
      .run();
  }
}

export async function completeLiveRevisionStage(env, payload, revisionState) {
  const db = env?.MINUTE_DB;
  if (!db) throw new Error('minute revision stage MINUTE_DB binding is missing');
  const state = validateRevisionState(revisionState, payload);
  const count = await db.prepare(
    'SELECT COUNT(*) AS item_count FROM sh_queue_revision_items WHERE revision_id=?',
  ).bind(state.revisionId).first();
  const materializedCount = Number(count?.item_count || 0);
  if (materializedCount < state.itemCount) {
    throw new Error(`queue revision ${state.revisionId} incomplete: ${materializedCount}/${state.itemCount}`);
  }
  await markRevisionCoverage(
    db,
    state.revisionId,
    materializedCount,
    state.totalItemCount,
  );
  return {
    revision_id: state.revisionId,
    item_count: materializedCount,
    total_item_count: state.totalItemCount,
    coverage_complete: materializedCount >= state.totalItemCount,
    complete: true,
  };
}
