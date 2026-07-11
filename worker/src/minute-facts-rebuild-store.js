import { saveLiveMinuteFactWithinBudget } from './collector-runner.js';
import {
  missingRevisionPositions,
  resolveTracksBulk,
} from './minute-facts-fast-store.js';
import {
  batchRun,
  FACT_QUALITY_FLAGS,
  findScheduledPosition,
  minuteBucket,
  qualityScore,
  queueRevisionItemStatement,
  queueStructuralHash,
  queueStructurePayload,
  reportedStreamCount,
  resolveHost,
  scheduleQueueTracks,
  timestampMs,
  upsertMinuteFact,
} from './minute-facts-store.js';

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function integer(value) {
  const parsed = num(value);
  return parsed == null ? null : Math.trunc(parsed);
}

function text(value) {
  if (value === null || value === undefined) return null;
  const parsed = String(value).trim();
  return parsed || null;
}

function bool(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return value === 0 ? 0 : 1;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return 1;
  if (['false', '0', 'no', 'off', ''].includes(normalized)) return 0;
  return null;
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

async function findRevision(db, input) {
  return db.prepare(`SELECT id,status,item_count,session_id FROM sh_queue_revisions
    WHERE channel_id=? AND structural_hash=? AND queue_start_time IS ?
      AND status IN ('complete','pending')
    ORDER BY CASE status WHEN 'complete' THEN 0 ELSE 1 END,effective_at DESC,id DESC
    LIMIT 1`)
    .bind(input.channelId, input.structuralHash, input.queueStart)
    .first();
}

async function createRebuildRevision(db, sourceDb, input) {
  const payload = queueStructurePayload(input.queue);
  const structuralHash = await queueStructuralHash(input.queue);
  const queueStart = timestampMs(input.queue?.start_time);
  let revision = await findRevision(db, {
    channelId: input.channelId,
    structuralHash,
    queueStart,
  });
  if (revision?.status === 'complete') return Number(revision.id);

  if (!revision) {
    await db.prepare(`INSERT OR IGNORE INTO sh_queue_revisions(
        session_id,channel_id,station_id,queue_id,queue_start_time,effective_at,received_at,
        structural_hash,item_count,status,source,source_priority
      ) VALUES(?,?,?,?,?,?,?,?,?,'pending','live_reconstructed',?)`)
      .bind(
        input.sessionId,
        input.channelId,
        input.stationId,
        integer(input.queue?.queue_id),
        queueStart,
        input.observedAt,
        input.receivedAt,
        structuralHash,
        payload.tracks.length,
        input.sourcePriority,
      )
      .run();
    revision = await db.prepare(`SELECT id,status,item_count,session_id FROM sh_queue_revisions
      WHERE channel_id=? AND effective_at=? AND structural_hash=?`)
      .bind(input.channelId, input.observedAt, structuralHash)
      .first();
  }

  const revisionId = Number(revision?.id);
  if (!Number.isFinite(revisionId)) throw new Error('failed to create historical queue revision');
  const existingResult = await db.prepare(
    'SELECT position FROM sh_queue_revision_items WHERE revision_id=?',
  ).bind(revisionId).all();
  const resolved = await resolveTracksBulk(db, sourceDb, payload.tracks, input.observedAt, {
    channelId: input.channelId,
    minuteAt: minuteBucket(input.observedAt),
    queueTracks: payload.tracks.length,
    revisionId,
  });

  const scheduled = scheduleQueueTracks(resolved);
  const missing = missingRevisionPositions(scheduled, existingResult.results || []);
  const byPosition = new Map((input.queue?.tracks || []).map(
    (track, index) => [integer(track?.position) ?? index, track],
  ));
  const statements = missing.map((track) => queueRevisionItemStatement(
    db, revisionId, track, integer(byPosition.get(track.position)?.bite_count),
  ));
  await batchRun(db, statements);

  const count = await db.prepare(
    'SELECT COUNT(*) AS item_count FROM sh_queue_revision_items WHERE revision_id=?',
  ).bind(revisionId).first();
  if (Number(count?.item_count || 0) !== payload.tracks.length) {
    throw new Error(`historical queue revision ${revisionId} incomplete`);
  }
  await db.prepare("UPDATE sh_queue_revisions SET status='complete' WHERE id=?")
    .bind(revisionId).run();
  return revisionId;
}

async function inferHistoricalPlayback(db, input) {
  if (bool(input.isPaused) === 1 || input.queueStartTime == null) {
    return { current_position: null, delayed: true };
  }
  const elapsed = input.observedAt - input.queueStartTime;
  if (elapsed < 0) return { current_position: null, delayed: true };
  const result = await db.prepare(`SELECT position,duration_ms,playback_offset_ms,schedule_valid
    FROM sh_queue_revision_items WHERE revision_id=? ORDER BY position ASC`)
    .bind(input.revisionId)
    .all();
  return {
    current_position: findScheduledPosition(result.results || [], elapsed),
    delayed: false,
  };
}

export async function saveReconstructedMinuteFact(env, input) {
  const db = env?.FACTS_DB;
  if (!db) return { skipped: true, reason: 'facts-db-binding-missing' };
  const snapshot = input.snapshot || {};
  const queue = input.queue || null;
  const rebuild = input.rebuild || {};
  const mode = rebuild.mode === 'carry_forward' ? 'carry_forward' : 'exact';
  const sourcePriority = mode === 'exact' ? 90 : 85;
  const observedAt = integer(input.observedAt) ?? Date.now();
  const receivedAt = Date.now();
  const channelId = integer(snapshot.channel_id);
  if (channelId == null) return { skipped: true, reason: 'channel-id-missing' };
  const stationId = integer(snapshot.station_id ?? queue?.station_id);

  const hostId = await resolveHost(db, {
    accountId: snapshot.host_account_id,
    handle: snapshot.host_handle,
  }, observedAt);
  const sessionId = await findHistoricalSession(db, {
    channelId,
    broadcastStartTime: snapshot.broadcast_start_time,
    observedAt,
  });

  let revisionId = null;
  let playback = null;
  if (queue && Array.isArray(queue.tracks) && bool(snapshot.is_broadcasting) !== 0) {
    revisionId = await createRebuildRevision(db, env.DB, {
      channelId,
      stationId,
      sessionId,
      queue,
      observedAt,
      receivedAt,
      sourcePriority,
    });
    playback = await inferHistoricalPlayback(db, {
      revisionId,
      queueStartTime: timestampMs(queue.start_time),
      observedAt,
      isPaused: queue.is_paused,
    });
  }

  const position = integer(playback?.current_position);
  const item = revisionId == null || position == null ? null : await db.prepare(`SELECT
      track_id,schedule_valid,bite_count FROM sh_queue_revision_items
      WHERE revision_id=? AND position=?`).bind(revisionId, position).first();
  const trackId = integer(item?.track_id);

  let flags = FACT_QUALITY_FLAGS.LEGACY_QUALITY_REDUCED;
  const broadcasting = bool(snapshot.is_broadcasting);
  if (mode === 'carry_forward') flags |= FACT_QUALITY_FLAGS.DELAYED_PAYLOAD;
  if (broadcasting === 0) flags |= FACT_QUALITY_FLAGS.OFFLINE;
  if (broadcasting !== 0 && !queue) flags |= FACT_QUALITY_FLAGS.QUEUE_MISSING;
  if (broadcasting !== 0 && queue && trackId == null) flags |= FACT_QUALITY_FLAGS.TRACK_UNKNOWN;
  if (trackId != null) flags |= FACT_QUALITY_FLAGS.TRACK_INFERRED;
  if (input.comments?.degraded) flags |= FACT_QUALITY_FLAGS.COMMENTS_DEGRADED;
  if (bool(queue?.is_paused) === 1) flags |= FACT_QUALITY_FLAGS.PAUSED;

  const minuteAt = minuteBucket(observedAt);
  const fact = {
    channel_id: channelId,
    station_id: stationId,
    minute_at: minuteAt,
    observed_at: observedAt,
    received_at: receivedAt,
    source: 'live_reconstructed',
    source_priority: sourcePriority,
    source_record_id: `snapshot:${rebuild.source_snapshot_id ?? 0}:minute:${minuteAt}:${mode}`,
    collector_id: `${text(env.COLLECTOR_ID) || 'cloudflare-worker'}:rebuild`,
    broadcast_session_id: sessionId,
    host_id: hostId,
    is_broadcasting: broadcasting,
    broadcast_start_time: timestampMs(snapshot.broadcast_start_time),
    listener_count: integer(snapshot.listener_count),
    online_member_count: integer(snapshot.online_member_count),
    total_member_count: integer(snapshot.total_member_count),
    guest_count: integer(snapshot.guest_count),
    reported_total_listens: integer(snapshot.total_listens),
    reported_current_stream_count: reportedStreamCount(snapshot.current_stream_count),
    validated_stream_count: null,
    stream_count_rejected: 0,
    queue_revision_id: revisionId,
    queue_id: integer(queue?.queue_id),
    queue_start_time: timestampMs(queue?.start_time),
    is_paused: bool(queue?.is_paused) === 1 ? 1 : 0,
    queue_track_count: Array.isArray(queue?.tracks) ? queue.tracks.length : null,
    queue_available: queue ? 1 : 0,
    track_id: trackId,
    queue_position: position,
    track_detection_method: trackId == null ? 'unknown' : 'queue_reconstructed',
    track_confidence: trackId == null ? 0 : (mode === 'exact' ? 0.75 : 0.6),
    schedule_valid: Number(item?.schedule_valid || 0),
    track_bite_count: integer(item?.bite_count),
    comment_count: integer(input.comments?.commentCount),
    comment_total: integer(input.comments?.commentTotal),
    comments_degraded: input.comments?.degraded ? 1 : 0,
    quality_score: qualityScore(flags),
    quality_flags: flags,
  };
  await upsertMinuteFact(db, fact);
  return { skipped: false, fact, sessionId, revisionId };
}

export function saveReconstructedMinuteFactWithinBudget(env, input) {
  return saveLiveMinuteFactWithinBudget(env, input, saveReconstructedMinuteFact);
}
