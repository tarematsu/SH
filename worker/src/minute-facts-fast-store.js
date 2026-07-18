import { saveMinuteFactWithinBudget } from './minute-facts-write-budget.js';
import { createPartialRevision } from './minute-partial-revision.js';
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
  missingRevisionPositions,
  resolveTracksBulk,
  timedStage,
} from './minute-facts-track-resolution.js';
import { updatePlaybackState, writeCurrentBite } from './minute-facts-legacy-revision.js';

export {
  buildTrackDescriptor,
  createPartialRevision as createOptimizedRevision,
  missingRevisionPositions,
  resolveTracksBulk,
};

function compactPlaybackQueue(queue) {
  if (!queue) return null;
  const tracks = Array.isArray(queue.tracks) ? queue.tracks : [];
  return {
    station_id: queue.station_id ?? null,
    queue_id: queue.queue_id ?? null,
    start_time: queue.start_time ?? null,
    total_track_count: integer(queue.total_track_count) ?? tracks.length,
    materialized_track_count: integer(queue.materialized_track_count) ?? tracks.length,
    source_structural_hash: queue.source_structural_hash ?? null,
    source_likes_hash: queue.source_likes_hash ?? null,
    tracks: tracks.map((track, index) => ({
      position: integer(track?.position) ?? index,
      queue_track_id: track?.queue_track_id ?? null,
      stationhead_track_id: track?.stationhead_track_id ?? null,
      spotify_id: track?.spotify_id ?? null,
      apple_music_id: track?.apple_music_id ?? null,
      isrc: track?.isrc ?? null,
      bite_count: track?.bite_count ?? null,
    })),
  };
}

async function enqueueMinuteEnrichment(env, input) {
  if (!env?.MINUTE_ENRICHMENT_QUEUE?.send) return false;
  const playbackPending = input.revisionId != null && input.broadcasting !== 0;
  await env.MINUTE_ENRICHMENT_QUEUE.send({
    message_type: 'minute-fact-enrichment',
    message_version: 1,
    stage: playbackPending ? 'playback' : 'identity',
    channel_id: input.channelId,
    station_id: input.stationId,
    minute_at: input.minuteAt,
    observed_at: input.observedAt,
    provisional_session_id: input.sessionId,
    revision_id: input.revisionId,
    queue_start_time: input.queueStartTime,
    is_paused: input.paused,
    host_account_id: input.snapshot.host_account_id ?? null,
    host_handle: input.snapshot.host_handle ?? null,
    broadcast_start_time: input.snapshot.broadcast_start_time ?? null,
    is_broadcasting: input.snapshot.is_broadcasting ?? null,
    queue: playbackPending ? compactPlaybackQueue(input.queue) : null,
  }, { contentType: 'json' });
  return true;
}

function preparedRevision(input) {
  const value = input?.prepared_revision;
  const revisionId = integer(value?.revision_id);
  if (revisionId == null) return null;
  return {
    revisionId,
    materializedCount: Math.max(0, integer(value?.materialized_item_count) ?? 0),
    totalCount: Math.max(
      0,
      integer(value?.total_item_count)
        ?? integer(input?.queue?.total_track_count)
        ?? input?.queue?.tracks?.length
        ?? 0,
    ),
  };
}

export async function saveOptimizedLiveMinuteFact(env, input) {
  const db = env?.MINUTE_DB;
  if (!db) return { skipped: true, reason: 'minute-db-binding-missing' };
  const snapshot = input.snapshot || {};
  const queue = input.queue || null;
  const tracks = Array.isArray(queue?.tracks) ? queue.tracks : null;
  const observedAt = integer(input.observedAt) ?? Date.now();
  const receivedAt = Date.now();
  const channelId = integer(snapshot.channel_id);
  if (channelId == null) return { skipped: true, reason: 'channel-id-missing' };
  const stationId = integer(snapshot.station_id ?? queue?.station_id);
  const minuteAt = minuteBucket(observedAt);
  const broadcasting = bool(snapshot.is_broadcasting);
  const queueStartTime = timestampMs(queue?.start_time);
  const paused = bool(queue?.is_paused) === 1;
  const deferred = Boolean(env?.MINUTE_ENRICHMENT_QUEUE?.send);
  const context = {
    channelId,
    minuteAt,
    queueTracks: tracks?.length || 0,
    revisionId: null,
  };

  const hostId = deferred ? null : await timedStage('resolve_host', context, () => resolveHost(db, {
    accountId: snapshot.host_account_id,
    handle: snapshot.host_handle,
  }, observedAt));
  // Keep session identity on the ordered derive path so queue revision identity
  // remains stable. Host resolution may complete later without changing the
  // durable revision key used by subsequent minute jobs.
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
  let revisionCoverage = null;
  if (queue && tracks && broadcasting !== 0) {
    const prepared = preparedRevision(input);
    if (prepared) {
      revisionId = prepared.revisionId;
      revisionCoverage = prepared;
    } else {
      const revision = await timedStage('create_or_resume_revision', context, () => createPartialRevision(
        db,
        env.DB,
        { channelId, stationId, sessionId, queue, observedAt, receivedAt },
      ));
      revisionId = revision.revisionId;
      revisionCoverage = revision;
    }
    context.revisionId = revisionId;
    if (!deferred) {
      playback = await timedStage('update_playback', context, () => updatePlaybackState(db, {
        channelId,
        sessionId,
        revisionId,
        queueStartTime,
        observedAt,
        isPaused: paused,
      }));
    }
  }

  const position = integer(playback?.current_position);
  const trackId = integer(playback?.current_track_id);
  const scheduleValid = Number(playback?.current_schedule_valid || 0);
  const biteCount = deferred || revisionId == null ? null : await timedStage('write_current_bite', context, () => writeCurrentBite(db, {
    channelId,
    stationId,
    revisionId,
    position,
    trackId,
    observedAt,
    queue,
  }));

  let flags = 0;
  if (broadcasting === 0) flags |= FACT_QUALITY_FLAGS.OFFLINE;
  if (broadcasting !== 0 && !queue) flags |= FACT_QUALITY_FLAGS.QUEUE_MISSING;
  if (broadcasting !== 0 && queue && trackId == null) flags |= FACT_QUALITY_FLAGS.TRACK_UNKNOWN;
  if (trackId != null) flags |= FACT_QUALITY_FLAGS.TRACK_INFERRED;
  if (input.comments?.degraded) flags |= FACT_QUALITY_FLAGS.COMMENTS_DEGRADED;
  if (playback?.delayed) flags |= FACT_QUALITY_FLAGS.DELAYED_PAYLOAD;
  if (paused) flags |= FACT_QUALITY_FLAGS.PAUSED;

  const fact = {
    channel_id: channelId,
    station_id: stationId,
    minute_at: minuteAt,
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
    queue_start_time: queueStartTime,
    is_paused: paused ? 1 : 0,
    queue_track_count: integer(queue?.total_track_count) ?? tracks?.length ?? null,
    queue_available: queue ? 1 : 0,
    track_id: trackId,
    queue_position: position,
    track_detection_code: trackId == null
      ? TRACK_DETECTION_METHOD_CODES.unknown
      : TRACK_DETECTION_METHOD_CODES.queue_inferred,
    track_confidence: trackId == null ? 0 : (playback?.delayed ? 0.6 : 0.9),
    schedule_valid: scheduleValid,
    track_bite_count: biteCount,
    comment_count: integer(input.comments?.commentCount ?? input.comments?.commentsSaved),
    comment_total: integer(input.comments?.commentTotal),
    comments_degraded: input.comments?.degraded ? 1 : 0,
    quality_score: qualityScore(flags),
    quality_flags: flags,
  };
  await timedStage('upsert_minute_fact', context, () => upsertMinuteFact(db, fact));
  if (deferred) {
    await enqueueMinuteEnrichment(env, {
      channelId,
      stationId,
      minuteAt,
      observedAt,
      sessionId,
      revisionId,
      queueStartTime,
      paused,
      broadcasting,
      snapshot,
      queue,
    });
  }
  return {
    skipped: false,
    fact,
    sessionId,
    revisionId,
    revision_materialized_count: revisionCoverage?.materializedCount ?? tracks?.length ?? 0,
    revision_total_count: revisionCoverage?.totalCount ?? integer(queue?.total_track_count) ?? tracks?.length ?? 0,
    enrichment_deferred: deferred,
  };
}

export function saveOptimizedMinuteFactWithinBudget(env, input) {
  return saveMinuteFactWithinBudget(env, input, saveOptimizedLiveMinuteFact);
}
