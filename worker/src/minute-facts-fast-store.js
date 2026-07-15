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
import { writeCurrentBite } from './minute-facts-legacy-revision.js';

export { buildTrackDescriptor, createOptimizedRevision, missingRevisionPositions, resolveTracksBulk };

async function updatePlaybackState(db, input) {
  const { channelId, sessionId, revisionId, queueStartTime, observedAt, isPaused } = input;
  const previous = await db.prepare('SELECT * FROM sh_playback_current WHERE channel_id=?')
    .bind(channelId).first();
  const paused = bool(isPaused) === 1;
  const delayed = previous && observedAt < Number(previous.last_observed_at || 0);
  if (delayed) return { ...previous, delayed: true };

  const revisionChanged = Number(previous?.revision_id || 0) !== Number(revisionId || 0);
  let pausedTotal = revisionChanged ? 0 : Number(previous?.paused_total_ms || 0);
  let pauseStartedAt = revisionChanged ? (paused ? observedAt : null) : integer(previous?.pause_started_at);
  const wasPaused = revisionChanged ? false : Number(previous?.is_paused || 0) === 1;
  if (!revisionChanged && !wasPaused && paused) pauseStartedAt = observedAt;
  if (!revisionChanged && wasPaused && !paused) {
    if (pauseStartedAt != null) pausedTotal += Math.max(0, observedAt - pauseStartedAt);
    pauseStartedAt = null;
  }
  if (revisionChanged || wasPaused !== paused) {
    await db.prepare(`INSERT OR IGNORE INTO sh_queue_state_events(
      revision_id,observed_at,is_paused,source
    ) VALUES(?,?,?,'live_collector')`).bind(revisionId, observedAt, paused ? 1 : 0).run();
  }

  const activePause = paused && pauseStartedAt != null ? Math.max(0, observedAt - pauseStartedAt) : 0;
  const elapsed = queueStartTime == null
    ? null
    : Math.max(0, observedAt - queueStartTime - pausedTotal - activePause);
  let currentPosition = null;
  if (elapsed != null) {
    const items = await db.prepare(`SELECT position,duration_ms,playback_offset_ms,schedule_valid
      FROM sh_queue_revision_items WHERE revision_id=? ORDER BY position ASC`).bind(revisionId).all();
    const match = (items.results || []).find((item) => Number(item.schedule_valid) === 1
      && elapsed >= Number(item.playback_offset_ms)
      && elapsed < Number(item.playback_offset_ms) + Number(item.duration_ms));
    currentPosition = match?.position == null ? null : Number(match.position);
  }

  await db.prepare(`INSERT INTO sh_playback_current(
      channel_id,session_id,revision_id,queue_start_time,is_paused,paused_total_ms,
      pause_started_at,last_observed_at,current_position
    ) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(channel_id) DO UPDATE SET
      session_id=excluded.session_id,revision_id=excluded.revision_id,
      queue_start_time=excluded.queue_start_time,is_paused=excluded.is_paused,
      paused_total_ms=excluded.paused_total_ms,pause_started_at=excluded.pause_started_at,
      last_observed_at=excluded.last_observed_at,current_position=excluded.current_position
    WHERE excluded.last_observed_at>=sh_playback_current.last_observed_at`).bind(
    channelId,
    sessionId,
    revisionId,
    queueStartTime,
    paused ? 1 : 0,
    pausedTotal,
    pauseStartedAt,
    observedAt,
    currentPosition,
  ).run();
  return {
    revision_id: revisionId,
    is_paused: paused ? 1 : 0,
    current_position: currentPosition,
    delayed: false,
  };
}

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
