import {
  FACT_QUALITY_FLAGS,
  MINUTE_FACT_SOURCE_CODES,
  qualityScore,
  resolveHost,
  resolveLiveSession,
  TRACK_DETECTION_METHOD_CODES,
} from './minute-facts-store.js';
import { integer } from './minute-facts-track-descriptor.js';
import { updatePlaybackState, writeCurrentBite } from './minute-facts-legacy-revision.js';
import { requestQueueExpansion } from './queue-materialization.js';

const EMPTY_DEPENDENCIES = Object.freeze({});
const EMPTY_TRACKS = Object.freeze([]);

function validateTask(body) {
  if (body?.message_type !== 'minute-fact-enrichment'
      || Number(body?.message_version) !== 1) {
    throw new Error('unsupported minute enrichment task');
  }
  const channelId = integer(body.channel_id);
  const minuteAt = integer(body.minute_at);
  const observedAt = integer(body.observed_at);
  if (channelId == null || minuteAt == null || observedAt == null) {
    throw new Error('minute enrichment identity is missing');
  }
  const stage = String(body.stage || 'identity');
  if (stage !== 'playback' && stage !== 'identity') {
    throw new Error(`unsupported minute enrichment stage: ${stage}`);
  }
  return { channelId, minuteAt, observedAt, stage };
}

async function loadCurrentMinute(db, identity) {
  return db.prepare(`SELECT id,observed_at,quality_flags FROM sh_minute_facts
    WHERE channel_id=? AND minute_at=? LIMIT 1`)
    .bind(identity.channelId, identity.minuteAt).first();
}

async function newestActiveSession(db, channelId) {
  return db.prepare(`SELECT id,last_observed_at FROM sh_broadcast_sessions
    WHERE channel_id=? AND status='active' AND source='live_collector'
    ORDER BY last_observed_at DESC,id DESC LIMIT 1`).bind(channelId).first();
}

async function resolveOrderedSession(db, body, identity, hostId) {
  const active = await newestActiveSession(db, identity.channelId);
  if (active && Number(active.last_observed_at || 0) > identity.observedAt) {
    const provisional = integer(body.provisional_session_id);
    if (provisional != null && hostId != null) {
      await db.prepare(`UPDATE sh_broadcast_sessions SET host_id=COALESCE(host_id,?)
        WHERE id=? AND channel_id=?`).bind(hostId, provisional, identity.channelId).run();
    }
    return provisional;
  }
  return resolveLiveSession(db, {
    channelId: identity.channelId,
    stationId: body.station_id,
    hostId,
    broadcastStartTime: body.broadcast_start_time,
    isBroadcasting: body.is_broadcasting,
    observedAt: identity.observedAt,
  });
}

async function attachSession(db, body, identity, sessionId) {
  const revisionId = integer(body.revision_id);
  if (sessionId == null || revisionId == null) return;
  await db.batch([
    db.prepare(`UPDATE sh_queue_revisions SET session_id=?
      WHERE id=? AND channel_id=? AND effective_at<=?`)
      .bind(sessionId, revisionId, identity.channelId, identity.observedAt),
    db.prepare(`UPDATE sh_playback_current SET session_id=?
      WHERE channel_id=? AND revision_id=? AND last_observed_at<=?`)
      .bind(sessionId, identity.channelId, revisionId, identity.observedAt),
  ]);
}

async function updateMinuteFactSession(db, identity, values) {
  // Migration 003 moved host and bite context out of sh_minute_facts. Host is
  // derived through the attached broadcast session and bite through the
  // canonical counter log, leaving only the compact fact's session FK here.
  await db.prepare(`UPDATE sh_minute_facts SET
      broadcast_session_id=COALESCE(?,broadcast_session_id)
    WHERE channel_id=? AND minute_at=? AND observed_at=? AND source_code=?`)
    .bind(
      values.sessionId,
      identity.channelId,
      identity.minuteAt,
      identity.observedAt,
      MINUTE_FACT_SOURCE_CODES.live_collector,
    ).run();
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
  return { trackId, position, flags, confidenceCode, detectionCode };
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
  const compactTracks = sourceTrack ? [{
    position,
    queue_track_id: sourceTrack.queue_track_id ?? null,
    stationhead_track_id: sourceTrack.stationhead_track_id ?? null,
    spotify_id: sourceTrack.spotify_id ?? null,
    apple_music_id: sourceTrack.apple_music_id ?? null,
    isrc: sourceTrack.isrc ?? null,
    bite_count: sourceTrack.bite_count ?? null,
  }] : EMPTY_TRACKS;
  return {
    station_id: queue.station_id ?? null,
    queue_id: queue.queue_id ?? null,
    start_time: queue.start_time ?? null,
    total_track_count: integer(queue.total_track_count) ?? tracks.length,
    materialized_track_count: integer(queue.materialized_track_count) ?? tracks.length,
    source_structural_hash: queue.source_structural_hash ?? null,
    source_likes_hash: queue.source_likes_hash ?? null,
    tracks: compactTracks,
  };
}

async function enqueueIdentityStage(env, body, playback, patched) {
  if (!env?.MINUTE_ENRICHMENT_QUEUE?.send) throw new Error('MINUTE_ENRICHMENT_QUEUE binding is missing');
  const position = integer(patched == null ? playback?.current_position : patched.position);
  const trackId = integer(patched == null ? playback?.current_track_id : patched.trackId);
  await env.MINUTE_ENRICHMENT_QUEUE.send({
    message_type: 'minute-fact-enrichment',
    message_version: 1,
    stage: 'identity',
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
    queue: compactCurrentBiteQueue(body.queue, position),
    queue_position: position,
    track_id: trackId,
  }, { contentType: 'json' });
}

function expansionProbePosition(queue, position) {
  const current = integer(position);
  if (current != null) return current;
  const total = integer(queue?.total_track_count);
  const materialized = integer(queue?.materialized_track_count)
    ?? (Array.isArray(queue?.tracks) ? queue.tracks.length : null);
  if (total == null || materialized == null || materialized <= 0 || materialized >= total) return null;
  // A delayed payload may land beyond the current materialized schedule and
  // therefore produce no position. Treat that as reaching this window's tail
  // so the next chunk is requested instead of permanently stalling coverage.
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

async function processPlaybackStage(env, body, identity, current, dependencies) {
  const revisionId = integer(body.revision_id);
  if (revisionId == null) throw new Error('minute playback revision id is missing');
  const updatePlayback = dependencies.updatePlaybackState || updatePlaybackState;
  const playback = await updatePlayback(env.MINUTE_DB, {
    channelId: identity.channelId,
    sessionId: body.provisional_session_id,
    revisionId,
    queueStartTime: body.queue_start_time,
    observedAt: identity.observedAt,
    isPaused: body.is_paused,
  });
  const patch = dependencies.patchPlaybackResult || patchPlaybackResult;
  const patched = await patch(env.MINUTE_DB, current, identity, playback);
  const expansionRequested = await maybeRequestExpansion(
    env,
    body,
    patched.position,
    identity,
    dependencies,
  );
  const enqueue = dependencies.enqueueIdentityStage || enqueueIdentityStage;
  await enqueue(env, body, playback, patched);
  return {
    skipped: false,
    pending: true,
    stage: 'playback',
    ...identity,
    queue_position: patched.position,
    track_id: patched.trackId,
    requested_materialized_tracks: expansionRequested,
  };
}

async function processIdentityStage(env, body, identity, dependencies) {
  const db = env?.MINUTE_DB;
  const resolveHostValue = dependencies.resolveHost || resolveHost;
  const hostId = await resolveHostValue(db, {
    accountId: body.host_account_id,
    handle: body.host_handle,
  }, identity.observedAt);
  const resolveSession = dependencies.resolveOrderedSession || resolveOrderedSession;
  const sessionId = await resolveSession(db, body, identity, hostId);
  const attach = dependencies.attachSession || attachSession;
  await attach(db, body, identity, sessionId);

  const revisionId = integer(body.revision_id);
  const position = integer(body.queue_position);
  const trackId = integer(body.track_id);
  const writeBite = dependencies.writeCurrentBite || writeCurrentBite;
  const biteCount = revisionId == null ? null : await writeBite(db, {
    channelId: identity.channelId,
    stationId: body.station_id,
    revisionId,
    position,
    trackId,
    observedAt: identity.observedAt,
    queue: body.queue,
  });

  const updateFact = dependencies.updateMinuteFactSession || updateMinuteFactSession;
  await updateFact(db, identity, { sessionId, hostId, biteCount });
  return {
    skipped: false,
    pending: false,
    stage: 'identity',
    ...identity,
    session_id: sessionId,
    host_id: hostId,
    bite_count: biteCount,
  };
}

export async function processMinuteEnrichment(env, body, dependencies = EMPTY_DEPENDENCIES) {
  const identity = validateTask(body);
  const db = env?.MINUTE_DB;
  if (!db?.prepare && !dependencies.loadCurrentMinute) throw new Error('MINUTE_DB binding is missing');

  // An older retried task must not rewrite a newer minute-fact winner.
  const loadCurrent = dependencies.loadCurrentMinute || loadCurrentMinute;
  const current = await loadCurrent(db, identity);
  if (integer(current?.observed_at) !== identity.observedAt) {
    return { skipped: true, reason: 'stale-minute-winner', ...identity };
  }

  return identity.stage === 'playback'
    ? processPlaybackStage(env, body, identity, current, dependencies)
    : processIdentityStage(env, body, identity, dependencies);
}

export default {
  async queue(batch, env) {
    const messages = batch?.messages;
    const count = messages?.length || 0;
    if (!count) return;
    let index = 0;
    do {
      const message = messages[index];
      try {
        const result = await processMinuteEnrichment(env, message.body);
        console.log(JSON.stringify({ event: 'minute_enrichment_completed', ...result }));
        message.ack();
      } catch (error) {
        console.error(JSON.stringify({
          event: 'minute_enrichment_failed',
          error: String(error?.message || error).slice(0, 800),
        }));
        message.retry({ delaySeconds: 30 });
      }
      index += 1;
    } while (index < count);
  },
  fetch() {
    return Response.json({ ok: false, error: 'not found' }, { status: 404 });
  },
};
