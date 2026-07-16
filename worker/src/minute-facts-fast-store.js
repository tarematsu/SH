import { saveMinuteFactWithinBudget } from './minute-facts-write-budget.js';
import {
  FACT_QUALITY_FLAGS,
  minuteBucket,
  MINUTE_FACT_SOURCE_CODES,
  qualityScore,
  reportedStreamCount,
  resolveHost,
  resolveLiveSession,
  timestampMs,
  TRACK_DETECTION_METHOD_CODES,
  upsertMinuteFact,
} from './minute-facts-store.js';
import { bool, buildTrackDescriptor, integer, text } from './minute-facts-track-descriptor.js';
import {
  createOptimizedRevision,
  missingRevisionPositions,
  resolveTracksBulk,
  timedStage,
} from './minute-facts-track-resolution.js';
import { updatePlaybackState, writeCurrentBite } from './minute-facts-legacy-revision.js';

export { buildTrackDescriptor, createOptimizedRevision, missingRevisionPositions, resolveTracksBulk };

export async function saveOptimizedLiveMinuteFact(env, input) {
  const db = env?.MINUTE_DB;
  if (!db) return { skipped: true, reason: 'minute-db-binding-missing' };
  const snapshot = input.snapshot || {};
  const queue = input.queue || null;
  const observedAt = integer(input.observedAt) ?? Date.now();
  const receivedAt = Date.now();
  const channelId = integer(snapshot.channel_id);
  if (channelId == null) return { skipped: true, reason: 'channel-id-missing' };
  const stationId = integer(snapshot.station_id ?? queue?.station_id);
  const context = {
    channelId,
    minuteAt: minuteBucket(observedAt),
    queueTracks: Array.isArray(queue?.tracks) ? queue.tracks.length : 0,
    revisionId: null,
  };

  const hostId = await timedStage('resolve_host', context, () => resolveHost(db, {
    accountId: snapshot.host_account_id,
    handle: snapshot.host_handle,
  }, observedAt));
  const sessionId = await timedStage('resolve_session', context, () => resolveLiveSession(db, {
    channelId,
    stationId,
    hostId,
    broadcastStartTime: snapshot.broadcast_start_time,
    isBroadcasting: snapshot.is_broadcasting,
    observedAt,
  }));

  let revisionId = null;
  let playback = null;
  if (queue && Array.isArray(queue.tracks) && bool(snapshot.is_broadcasting) !== 0) {
    const revision = await timedStage('create_or_resume_revision', context, () => createOptimizedRevision(
      db,
      env.DB,
      { channelId, stationId, sessionId, queue, observedAt, receivedAt },
    ));
    revisionId = revision.revisionId;
    context.revisionId = revisionId;
    playback = await timedStage('update_playback', context, () => updatePlaybackState(db, {
      channelId,
      sessionId,
      revisionId,
      queueStartTime: timestampMs(queue.start_time),
      observedAt,
      isPaused: queue.is_paused,
    }));
  }

  const position = integer(playback?.current_position);
  const item = revisionId == null || position == null ? null : await db.prepare(`SELECT
      track_id,schedule_valid FROM sh_queue_revision_items WHERE revision_id=? AND position=?`)
    .bind(revisionId, position).first();
  const trackId = integer(item?.track_id);
  const biteCount = revisionId == null ? null : await timedStage('write_current_bite', context, () => writeCurrentBite(db, {
    channelId,
    stationId,
    revisionId,
    position,
    observedAt,
    queue,
  }));

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
  await timedStage('upsert_minute_fact', context, () => upsertMinuteFact(db, fact));
  return { skipped: false, fact, sessionId, revisionId };
}

export function saveOptimizedMinuteFactWithinBudget(env, input) {
  return saveMinuteFactWithinBudget(env, input, saveOptimizedLiveMinuteFact);
}