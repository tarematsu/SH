import { saveMinuteFactWithinBudget } from './minute-facts-write-budget.js';
import {
  FACT_QUALITY_FLAGS,
  minuteBucket,
  MINUTE_FACT_SOURCE_CODES,
  qualityScore,
  reportedStreamCount,
  resolveHost,
  timestampMs,
  TRACK_DETECTION_METHOD_CODES,
  upsertMinuteFact,
} from './minute-facts-store.js';
import {
  bool,
  integer,
  text,
} from './minute-facts-track-descriptor.js';

export async function saveSparseReconstructedMinuteFact(env, input) {
  const db = env?.MINUTE_DB;
  if (!db) return { skipped: true, reason: 'minute-db-binding-missing' };
  const snapshot = input.snapshot || {};
  const queue = input.queue || null;
  const rebuild = input.rebuild || {};
  const prepared = input.prepared_revision || {};
  const revisionId = integer(prepared.revision_id);
  if (revisionId == null) throw new Error('sparse rebuild revision identity is missing');

  const mode = rebuild.mode === 'carry_forward' ? 'carry_forward' : 'exact';
  const sourcePriority = mode === 'exact' ? 90 : 85;
  const observedAt = integer(input.observedAt) ?? Date.now();
  const receivedAt = Date.now();
  const channelId = integer(snapshot.channel_id);
  if (channelId == null) return { skipped: true, reason: 'channel-id-missing' };
  const stationId = integer(snapshot.station_id ?? queue?.station_id);
  const sessionId = integer(prepared?.enrichment?.provisional_session_id);
  const position = integer(prepared.fact_position);
  const delayed = Boolean(prepared.fact_delayed);
  const hostId = await resolveHost(db, {
    accountId: snapshot.host_account_id,
    handle: snapshot.host_handle,
  }, observedAt);
  const item = position == null ? null : await db.prepare(`SELECT
      track_id,schedule_valid,bite_count FROM sh_queue_revision_items
      WHERE revision_id=? AND position=?`).bind(revisionId, position).first();
  const trackId = integer(item?.track_id);

  let flags = FACT_QUALITY_FLAGS.LEGACY_QUALITY_REDUCED;
  const broadcasting = bool(snapshot.is_broadcasting);
  if (mode === 'carry_forward' || delayed) flags |= FACT_QUALITY_FLAGS.DELAYED_PAYLOAD;
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
    source_code: MINUTE_FACT_SOURCE_CODES.live_reconstructed,
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
      : TRACK_DETECTION_METHOD_CODES.queue_reconstructed,
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

export function saveSparseReconstructedMinuteFactWithinBudget(env, input) {
  return saveMinuteFactWithinBudget(env, input, saveSparseReconstructedMinuteFact);
}
