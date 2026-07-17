import {
  bool,
  FACT_QUALITY_FLAGS,
  integer,
  minuteBucket,
  minuteFactStatement,
  qualityScore,
  queueRevisionItemStatement,
  reportedStreamCount,
  scheduleQueueTracks,
  findScheduledPosition,
  text,
  timestampMs,
  batchRun,
  ensureMinuteFactCollectorCode,
} from './minute-facts-normalize.js';
import {
  queueStructuralHash,
  queueStructurePayload,
  resetQueueStructureCacheForTests,
} from './minute-facts-queue-cache.js';
import { minuteFactStatements } from './minute-facts-statement-plan.js';
import { resolveHost, resolveLiveSession, resolveTrack } from './minute-facts-legacy-resolve.js';
import { createRevision, updatePlaybackState, writeCurrentBite } from './minute-facts-legacy-revision.js';

export {
  FACT_QUALITY_FLAGS,
  minuteBucket,
  minuteFactStatement,
  minuteFactStatements,
  qualityScore,
  queueRevisionItemStatement,
  queueStructuralHash,
  queueStructurePayload,
  resetQueueStructureCacheForTests,
  reportedStreamCount,
  scheduleQueueTracks,
  findScheduledPosition,
  timestampMs,
  batchRun,
  resolveHost,
  resolveLiveSession,
  resolveTrack,
};

export const MINUTE_FACT_SOURCES = Object.freeze({
  1: 'live_collector',
  2: 'live_reconstructed',
  3: 'legacy_normalized',
  4: 'legacy_raw',
});
export const MINUTE_FACT_SOURCE_CODES = Object.freeze(
  Object.fromEntries(Object.entries(MINUTE_FACT_SOURCES).map(([code, name]) => [name, Number(code)])),
);
export function minuteFactSourceCode(name) {
  return MINUTE_FACT_SOURCE_CODES[name] ?? null;
}
export function minuteFactSourceName(code) {
  return MINUTE_FACT_SOURCES[Number(code)] ?? null;
}

export const TRACK_DETECTION_METHODS = Object.freeze({
  0: 'unknown',
  1: 'queue_inferred',
  2: 'queue_reconstructed',
});
export const TRACK_DETECTION_METHOD_CODES = Object.freeze(
  Object.fromEntries(Object.entries(TRACK_DETECTION_METHODS).map(([code, name]) => [name, Number(code)])),
);
export function trackDetectionMethodCode(name) {
  return TRACK_DETECTION_METHOD_CODES[name] ?? TRACK_DETECTION_METHOD_CODES.unknown;
}
export function trackDetectionMethodName(code) {
  return TRACK_DETECTION_METHODS[Number(code)] ?? TRACK_DETECTION_METHODS[0];
}

export async function upsertMinuteFact(db, fact) {
  const collectorCode = fact.collector_code == null
    ? await ensureMinuteFactCollectorCode(db, fact.collector_id)
    : fact.collector_code;
  return db.batch(minuteFactStatements(db, { ...fact, collector_code: collectorCode }));
}

export async function saveLiveMinuteFact(env, input) {
  const db = env?.MINUTE_DB;
  if (!db) return { skipped: true, reason: 'minute-db-binding-missing' };
  const snapshot = input.snapshot || {};
  const queue = input.queue || null;
  const observedAt = integer(input.observedAt) ?? Date.now();
  const receivedAt = Date.now();
  const channelId = integer(snapshot.channel_id);
  if (channelId == null) return { skipped: true, reason: 'channel-id-missing' };
  const stationId = integer(snapshot.station_id ?? queue?.station_id);
  const hostId = await resolveHost(db, {
    accountId: snapshot.host_account_id,
    handle: snapshot.host_handle,
  }, observedAt);
  const sessionId = await resolveLiveSession(db, {
    channelId,
    stationId,
    hostId,
    broadcastStartTime: snapshot.broadcast_start_time,
    isBroadcasting: snapshot.is_broadcasting,
    observedAt,
  });

  let revisionId = null;
  let playback = null;
  if (queue && Array.isArray(queue.tracks) && bool(snapshot.is_broadcasting) !== 0) {
    const revision = await createRevision(db, env.DB, {
      channelId,
      stationId,
      sessionId,
      queue,
      observedAt,
      receivedAt,
    });
    revisionId = revision.revisionId;
    playback = await updatePlaybackState(db, {
      channelId,
      sessionId,
      revisionId,
      queueStartTime: timestampMs(queue.start_time),
      observedAt,
      isPaused: queue.is_paused,
    });
  }

  const position = integer(playback?.current_position);
  const item = revisionId == null || position == null ? null : await db.prepare(`SELECT
      track_id,schedule_valid FROM sh_queue_revision_items WHERE revision_id=? AND position=?`)
    .bind(revisionId, position).first();
  const trackId = integer(item?.track_id);
  const biteCount = revisionId == null ? null : await writeCurrentBite(db, {
    channelId, stationId, revisionId, position, observedAt, queue,
  });

  let flags = 0;
  const broadcasting = bool(snapshot.is_broadcasting);
  if (broadcasting === 0) flags |= FACT_QUALITY_FLAGS.OFFLINE;
  if (broadcasting !== 0 && !queue) flags |= FACT_QUALITY_FLAGS.QUEUE_MISSING;
  if (broadcasting !== 0 && queue && trackId == null) flags |= FACT_QUALITY_FLAGS.TRACK_UNKNOWN;
  if (trackId != null) flags |= FACT_QUALITY_FLAGS.TRACK_INFERRED;
  if (input.comments?.degraded) flags |= FACT_QUALITY_FLAGS.COMMENTS_DEGRADED;
  if (playback?.delayed) flags |= FACT_QUALITY_FLAGS.DELAYED_PAYLOAD;
  if (bool(queue?.is_paused) === 1) flags |= FACT_QUALITY_FLAGS.PAUSED;

  const fact = {
    channel_id: channelId,
    station_id: stationId,
    minute_at: minuteBucket(observedAt),
    observed_at: observedAt,
    received_at: receivedAt,
    source_code: MINUTE_FACT_SOURCE_CODES.live_collector,
    source_priority: 100,
    source_record_id: null,
    collector_id: text(env.COLLECTOR_ID) || 'cloudflare-worker',
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
    queue_revision_id: revisionId,
    queue_id: integer(queue?.queue_id),
    queue_start_time: timestampMs(queue?.start_time),
    is_paused: bool(queue?.is_paused) === 1 ? 1 : 0,
    queue_track_count: Array.isArray(queue?.tracks) ? queue.tracks.length : null,
    queue_available: queue ? 1 : 0,
    track_id: trackId,
    queue_position: position,
    track_detection_code: trackId == null
      ? TRACK_DETECTION_METHOD_CODES.unknown
      : TRACK_DETECTION_METHOD_CODES.queue_inferred,
    track_confidence: trackId == null ? 0 : (playback?.delayed ? 0.6 : 0.9),
    schedule_valid: Number(item?.schedule_valid || 0),
    track_bite_count: biteCount,
    comment_count: integer(input.comments?.commentCount ?? input.comments?.commentsSaved),
    comment_total: integer(input.comments?.commentTotal),
    comments_degraded: input.comments?.degraded ? 1 : 0,
    quality_score: qualityScore(flags),
    quality_flags: flags,
  };
  await upsertMinuteFact(db, fact);
  return { skipped: false, fact, sessionId, revisionId };
}
