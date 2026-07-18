import {
  bool,
  integer,
} from './minute-facts-track-descriptor.js';
import {
  queueStructuralHash,
  queueStructurePayload,
  timestampMs,
} from './minute-facts-store.js';

export function shouldMaterializeRebuildRevision(_env, payload) {
  const tracks = Array.isArray(payload?.queue?.tracks) ? payload.queue.tracks : [];
  return Boolean(payload?.rebuild)
    && tracks.length > 0
    && bool(payload?.snapshot?.is_broadcasting) !== 0;
}

async function findHistoricalSession(db, input) {
  const broadcastStart = timestampMs(input.broadcastStartTime);
  if (broadcastStart == null) return null;
  const row = await db.prepare(`SELECT id FROM sh_broadcast_sessions
    WHERE channel_id=? AND broadcast_start_time=?
    ORDER BY ABS(first_observed_at-?) ASC,id ASC LIMIT 1`)
    .bind(input.channelId, broadcastStart, input.observedAt)
    .first();
  return row?.id == null ? null : Number(row.id);
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

async function revisionPositionExists(db, revisionId, position) {
  if (position == null) return false;
  const row = await db.prepare(`SELECT 1 AS present FROM sh_queue_revision_items
    WHERE revision_id=? AND position=? LIMIT 1`).bind(revisionId, position).first();
  return Boolean(row);
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

export function historicalPlaybackState(queue, observedAt) {
  const tracks = Array.isArray(queue?.tracks) ? queue.tracks : [];
  if (bool(queue?.is_paused) === 1) return { position: null, delayed: true };

  const explicit = integer(queue?.current_position);
  if (explicit != null && tracks.some((track, index) => (
    integer(track?.position) ?? index
  ) === explicit)) {
    return { position: explicit, delayed: false };
  }

  const queueStart = timestampMs(queue?.start_time);
  if (queueStart == null) return { position: null, delayed: true };
  const elapsed = observedAt - queueStart;
  if (elapsed < 0) return { position: null, delayed: true };

  let offset = 0;
  for (let index = 0; index < tracks.length; index += 1) {
    const duration = integer(tracks[index]?.duration_ms);
    if (duration == null || duration <= 0) return { position: null, delayed: false };
    if (elapsed < offset + duration) {
      return {
        position: integer(tracks[index]?.position) ?? index,
        delayed: false,
      };
    }
    offset += duration;
  }
  return { position: null, delayed: false };
}

export async function prepareSparseRebuildRevision(env, payload, options = {}, dependencies = {}) {
  const db = env?.MINUTE_DB;
  if (!db) throw new Error('minute rebuild revision MINUTE_DB binding is missing');
  if (!shouldMaterializeRebuildRevision(env, payload)) return { staged: false };

  const sourceJobId = integer(options.sourceJobId);
  if (sourceJobId == null) throw new Error('minute rebuild revision source job identity is missing');
  const snapshot = payload.snapshot || {};
  const queue = payload.queue || {};
  const rebuild = payload.rebuild || {};
  const observedAt = integer(payload.observedAt) ?? Date.now();
  const receivedAt = Date.now();
  const channelId = integer(snapshot.channel_id);
  if (channelId == null) throw new Error('minute rebuild revision channel identity is missing');
  const stationId = integer(snapshot.station_id ?? queue.station_id);
  const sourcePriority = rebuild.mode === 'carry_forward' ? 85 : 90;
  const resolveSession = dependencies.findHistoricalSession || findHistoricalSession;
  const sessionId = await resolveSession(db, {
    channelId,
    broadcastStartTime: snapshot.broadcast_start_time,
    observedAt,
  });
  const structure = queueStructurePayload(queue);
  const visibleCount = structure.tracks.length;
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
      ) VALUES(?,?,?,?,?,?,?,?,?,'pending','live_reconstructed',?,0,0,?,?,NULL)`)
      .bind(
        sessionId,
        channelId,
        stationId,
        integer(queue.queue_id),
        queueStart,
        observedAt,
        receivedAt,
        structuralHash,
        visibleCount,
        sourcePriority,
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
  if (!Number.isFinite(revisionId)) throw new Error('failed to create or resume sparse rebuild revision');
  const loadProgress = dependencies.revisionProgress || revisionProgress;
  const materializedCount = await loadProgress(db, revisionId);
  const updateSource = dependencies.updateRevisionSource || (async () => db.prepare(`UPDATE sh_queue_revisions SET
      item_count=MAX(item_count,?),source_job_id=?,
      source_visible_count=MAX(COALESCE(source_visible_count,0),?),
      source_priority=MAX(source_priority,?),materialized_item_count=?,coverage_complete=?,
      status=CASE WHEN ?>=? THEN 'complete' ELSE 'pending' END
    WHERE id=?`)
    .bind(
      visibleCount,
      sourceJobId,
      visibleCount,
      sourcePriority,
      materializedCount,
      materializedCount >= visibleCount ? 1 : 0,
      materializedCount,
      visibleCount,
      revisionId,
    )
    .run());
  await updateSource();

  const playback = historicalPlaybackState(queue, observedAt);
  const firstPosition = integer(queue?.tracks?.[0]?.position) ?? 0;
  const preferredPosition = playback.position ?? firstPosition;
  const checkPosition = dependencies.revisionPositionExists || revisionPositionExists;
  const preferredMaterialized = playback.position == null
    ? true
    : await checkPosition(db, revisionId, playback.position);

  return {
    staged: materializedCount < visibleCount,
    sparse: true,
    rebuild: true,
    revision_id: revisionId,
    source_job_id: sourceJobId,
    visible_item_count: visibleCount,
    total_item_count: visibleCount,
    materialized_item_count: materializedCount,
    preferred_position: preferredPosition,
    preferred_materialized: preferredMaterialized,
    fact_position: playback.position,
    fact_delayed: playback.delayed,
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
    queue_identity: compactQueueIdentity(queue, visibleCount),
  };
}
