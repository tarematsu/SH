import {
  FACT_QUALITY_FLAGS,
  MINUTE_FACT_SOURCE_CODES,
  qualityScore,
  TRACK_DETECTION_METHOD_CODES,
} from './minute-facts-store.js';
import { integer } from './minute-facts-track-descriptor.js';
import { updatePlaybackState } from './minute-facts-legacy-revision.js';
import { requestQueueExpansion } from './queue-materialization.js';

export const PLAYBACK_PATCH_STAGE = 'playback-patch';

const EMPTY_DEPENDENCIES = Object.freeze({});
const EMPTY_TRACKS = Object.freeze([]);
const JSON_QUEUE_OPTIONS = Object.freeze({ contentType: 'json' });

function identityFrom(body) {
  const channelId = integer(body?.channel_id);
  const minuteAt = integer(body?.minute_at);
  const observedAt = integer(body?.observed_at);
  if (channelId == null || minuteAt == null || observedAt == null) {
    throw new Error('minute enrichment identity is missing');
  }
  return { channelId, minuteAt, observedAt };
}

async function loadCurrentMinute(db, identity) {
  return db.prepare(`SELECT id,observed_at,quality_flags FROM sh_minute_facts
    WHERE channel_id=? AND minute_at=? LIMIT 1`)
    .bind(identity.channelId, identity.minuteAt).first();
}

function staleWinner(current, identity) {
  return integer(current?.observed_at) !== identity.observedAt;
}

function compactCurrentBiteQueue(queue, position) {
  if (!queue || position == null) return null;
  const tracks = Array.isArray(queue.tracks) ? queue.tracks : EMPTY_TRACKS;
  let sourceTrack = tracks[position];
  if (!sourceTrack || (integer(sourceTrack.position) ?? position) !== position) {
    sourceTrack = null;
    for (let index = 0; index < tracks.length; index += 1) {
      const candidate = tracks[index];
      if ((integer(candidate?.position) ?? index) === position) {
        sourceTrack = candidate;
        break;
      }
    }
  }
  return {
    station_id: queue.station_id ?? null,
    queue_id: queue.queue_id ?? null,
    start_time: queue.start_time ?? null,
    total_track_count: integer(queue.total_track_count) ?? tracks.length,
    materialized_track_count: integer(queue.materialized_track_count) ?? tracks.length,
    source_structural_hash: queue.source_structural_hash ?? null,
    source_likes_hash: queue.source_likes_hash ?? null,
    tracks: sourceTrack ? [{
      position,
      queue_track_id: sourceTrack.queue_track_id ?? null,
      stationhead_track_id: sourceTrack.stationhead_track_id ?? null,
      spotify_id: sourceTrack.spotify_id ?? null,
      apple_music_id: sourceTrack.apple_music_id ?? null,
      isrc: sourceTrack.isrc ?? null,
      bite_count: sourceTrack.bite_count ?? null,
    }] : EMPTY_TRACKS,
  };
}

async function sendStage(env, message, dependencies) {
  if (dependencies.sendStage) {
    await dependencies.sendStage(message);
    return;
  }
  if (!env?.MINUTE_ENRICHMENT_QUEUE?.send) {
    throw new Error('MINUTE_ENRICHMENT_QUEUE binding is missing');
  }
  await env.MINUTE_ENRICHMENT_QUEUE.send(message, JSON_QUEUE_OPTIONS);
}

function baseIdentityMessage(body, stage) {
  return {
    message_type: 'minute-fact-enrichment',
    message_version: 1,
    stage,
    channel_id: body.channel_id,
    station_id: body.station_id,
    minute_at: body.minute_at,
    observed_at: body.observed_at,
    provisional_session_id: body.provisional_session_id,
    revision_id: body.revision_id,
    host_account_id: body.host_account_id,
    host_handle: body.host_handle,
    broadcast_start_time: body.broadcast_start_time,
    is_broadcasting: body.is_broadcasting,
  };
}

export async function processMinutePlaybackResolve(
  env,
  body,
  dependencies = EMPTY_DEPENDENCIES,
) {
  const identity = identityFrom(body);
  const db = env?.MINUTE_DB;
  if (!db?.prepare && !dependencies.loadCurrentMinute) {
    throw new Error('MINUTE_DB binding is missing');
  }
  const loadCurrent = dependencies.loadCurrentMinute || loadCurrentMinute;
  const current = await loadCurrent(db, identity);
  if (staleWinner(current, identity)) {
    return { skipped: true, reason: 'stale-minute-winner', stage: 'playback', ...identity };
  }
  const revisionId = integer(body.revision_id);
  if (revisionId == null) throw new Error('minute playback revision id is missing');
  const updatePlayback = dependencies.updatePlaybackState || updatePlaybackState;
  const playback = await updatePlayback(db, {
    channelId: identity.channelId,
    sessionId: body.provisional_session_id,
    revisionId,
    queueStartTime: body.queue_start_time,
    observedAt: identity.observedAt,
    isPaused: body.is_paused,
  });
  const position = integer(playback?.current_position);
  const trackId = integer(playback?.current_track_id);
  await sendStage(env, {
    ...baseIdentityMessage(body, PLAYBACK_PATCH_STAGE),
    queue: compactCurrentBiteQueue(body.queue, position),
    playback: {
      current_position: position,
      current_track_id: trackId,
      current_schedule_valid: Number(playback?.current_schedule_valid || 0),
      delayed: playback?.delayed === true,
    },
  }, dependencies);
  return {
    skipped: false,
    pending: true,
    stage: 'playback',
    ...identity,
    queue_position: position,
    track_id: trackId,
    playback_patch_deferred: true,
  };
}

async function patchPlaybackResult(db, current, identity, playback) {
  const factId = integer(current?.id);
  if (factId == null) throw new Error('minute enrichment fact id is missing');
  const trackId = integer(playback?.current_track_id);
  const position = integer(playback?.current_position);
  let flags = integer(current?.quality_flags) || 0;
  if (trackId == null) {
    flags |= FACT_QUALITY_FLAGS.TRACK_UNKNOWN;
    flags &= ~FACT_QUALITY_FLAGS.TRACK_INFERRED;
  } else {
    flags &= ~FACT_QUALITY_FLAGS.TRACK_UNKNOWN;
    flags |= FACT_QUALITY_FLAGS.TRACK_INFERRED;
  }
  if (playback?.delayed) flags |= FACT_QUALITY_FLAGS.DELAYED_PAYLOAD;
  const confidenceCode = trackId == null ? 0 : (playback?.delayed ? 60 : 90);
  const detectionCode = trackId == null
    ? TRACK_DETECTION_METHOD_CODES.unknown
    : TRACK_DETECTION_METHOD_CODES.queue_inferred;
  const qualityCode = Math.round(qualityScore(flags) * 100);
  await db.batch([
    db.prepare(`UPDATE sh_minute_facts SET
        track_detection_code=?,track_confidence_code=?,schedule_valid=?,
        quality_score_code=?,quality_flags=?
      WHERE id=? AND observed_at=? AND source_code=?`)
      .bind(
        detectionCode,
        confidenceCode,
        Number(playback?.current_schedule_valid || 0),
        qualityCode,
        flags,
        factId,
        identity.observedAt,
        MINUTE_FACT_SOURCE_CODES.live_collector,
      ),
    db.prepare(`UPDATE sh_minute_fact_context_v2 SET queue_position=?
      WHERE fact_id=?`).bind(position, factId),
  ]);
  return { trackId, position };
}

function expansionProbePosition(queue, position) {
  const current = integer(position);
  if (current != null) return current;
  const total = integer(queue?.total_track_count);
  const materialized = integer(queue?.materialized_track_count)
    ?? (Array.isArray(queue?.tracks) ? queue.tracks.length : null);
  if (total == null || materialized == null || materialized <= 0 || materialized >= total) return null;
  return materialized - 1;
}

async function maybeRequestExpansion(env, body, position, identity, dependencies) {
  if (!body.queue) return null;
  const probePosition = expansionProbePosition(body.queue, position);
  if (probePosition == null) return null;
  const request = dependencies.requestQueueExpansion || requestQueueExpansion;
  try {
    return await request(
      env?.BUDDIES_DB,
      body.queue,
      probePosition,
      identity.observedAt,
      env,
    );
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'queue_materialization_expand_failed',
      revision_id: integer(body.revision_id),
      queue_position: integer(position),
      expansion_probe_position: probePosition,
      error: String(error?.message || error).slice(0, 500),
    }));
    return null;
  }
}

export async function processMinutePlaybackPatch(
  env,
  body,
  dependencies = EMPTY_DEPENDENCIES,
) {
  const identity = identityFrom(body);
  const db = env?.MINUTE_DB;
  if (!db?.prepare && !dependencies.loadCurrentMinute) {
    throw new Error('MINUTE_DB binding is missing');
  }
  const loadCurrent = dependencies.loadCurrentMinute || loadCurrentMinute;
  const current = await loadCurrent(db, identity);
  if (staleWinner(current, identity)) {
    return { skipped: true, reason: 'stale-minute-winner', stage: PLAYBACK_PATCH_STAGE, ...identity };
  }
  const playback = body?.playback || {};
  const patch = dependencies.patchPlaybackResult || patchPlaybackResult;
  const patched = await patch(db, current, identity, playback);
  const expansionRequested = await maybeRequestExpansion(
    env,
    body,
    patched.position,
    identity,
    dependencies,
  );
  await sendStage(env, {
    ...baseIdentityMessage(body, 'identity'),
    queue: compactCurrentBiteQueue(body.queue, patched.position),
    queue_position: patched.position,
    track_id: patched.trackId,
  }, dependencies);
  return {
    skipped: false,
    pending: true,
    stage: PLAYBACK_PATCH_STAGE,
    ...identity,
    queue_position: patched.position,
    track_id: patched.trackId,
    requested_materialized_tracks: expansionRequested,
  };
}
