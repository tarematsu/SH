import {
  MINUTE_FACT_SOURCE_CODES,
  resolveHost,
  resolveLiveSession,
} from './minute-facts-store.js';
import { integer } from './minute-facts-track-descriptor.js';
import { writeCurrentBite } from './minute-facts-legacy-revision.js';

export const IDENTITY_BITE_STAGE = 'identity-bite';

const EMPTY_DEPENDENCIES = Object.freeze({});
const JSON_QUEUE_OPTIONS = Object.freeze({ contentType: 'json' });

function identityFrom(body, expectedStage) {
  if (body?.message_type !== 'minute-fact-enrichment'
      || Number(body?.message_version) !== 1
      || String(body?.stage || '') !== expectedStage) {
    throw new Error(`unsupported minute enrichment ${expectedStage} task`);
  }
  const channelId = integer(body.channel_id);
  const minuteAt = integer(body.minute_at);
  const observedAt = integer(body.observed_at);
  if (channelId == null || minuteAt == null || observedAt == null) {
    throw new Error('minute enrichment identity is missing');
  }
  return { channelId, minuteAt, observedAt };
}

async function loadCurrentMinute(db, identity) {
  return db.prepare(`SELECT id,observed_at FROM sh_minute_facts
    WHERE channel_id=? AND minute_at=? LIMIT 1`)
    .bind(identity.channelId, identity.minuteAt).first();
}

function staleWinner(current, identity) {
  return integer(current?.observed_at) !== identity.observedAt;
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

async function attachSessionAndFact(db, body, identity, sessionId) {
  const statements = [
    db.prepare(`UPDATE sh_minute_facts SET
        broadcast_session_id=COALESCE(?,broadcast_session_id)
      WHERE channel_id=? AND minute_at=? AND observed_at=? AND source_code=?`)
      .bind(
        sessionId,
        identity.channelId,
        identity.minuteAt,
        identity.observedAt,
        MINUTE_FACT_SOURCE_CODES.live_collector,
      ),
  ];
  const revisionId = integer(body.revision_id);
  if (sessionId != null && revisionId != null) {
    statements.push(
      db.prepare(`UPDATE sh_queue_revisions SET session_id=?
        WHERE id=? AND channel_id=? AND effective_at<=?`)
        .bind(sessionId, revisionId, identity.channelId, identity.observedAt),
      db.prepare(`UPDATE sh_playback_current SET session_id=?
        WHERE channel_id=? AND revision_id=? AND last_observed_at<=?`)
        .bind(sessionId, identity.channelId, revisionId, identity.observedAt),
    );
  }
  await db.batch(statements);
}

function biteMessage(body, sessionId, hostId) {
  return {
    message_type: 'minute-fact-enrichment',
    message_version: 1,
    stage: IDENTITY_BITE_STAGE,
    channel_id: body.channel_id,
    station_id: body.station_id,
    minute_at: body.minute_at,
    observed_at: body.observed_at,
    revision_id: body.revision_id,
    queue: body.queue || null,
    queue_position: body.queue_position,
    track_id: body.track_id,
    session_id: sessionId,
    host_id: hostId,
  };
}

async function sendBiteStage(env, message) {
  if (!env?.MINUTE_ENRICHMENT_QUEUE?.send) {
    throw new Error('MINUTE_ENRICHMENT_QUEUE binding is missing');
  }
  await env.MINUTE_ENRICHMENT_QUEUE.send(message, JSON_QUEUE_OPTIONS);
}

export async function processMinuteIdentitySession(
  env,
  body,
  dependencies = EMPTY_DEPENDENCIES,
) {
  const identity = identityFrom(body, 'identity');
  const db = env?.MINUTE_DB;
  if (!db?.prepare && !dependencies.loadCurrentMinute) {
    throw new Error('MINUTE_DB binding is missing');
  }
  const loadCurrent = dependencies.loadCurrentMinute || loadCurrentMinute;
  const current = await loadCurrent(db, identity);
  if (staleWinner(current, identity)) {
    return { skipped: true, reason: 'stale-minute-winner', stage: 'identity', ...identity };
  }

  const resolveHostValue = dependencies.resolveHost || resolveHost;
  const hostId = await resolveHostValue(db, {
    accountId: body.host_account_id,
    handle: body.host_handle,
  }, identity.observedAt);
  const resolveSession = dependencies.resolveSession || resolveOrderedSession;
  const sessionId = await resolveSession(db, body, identity, hostId);
  const attach = dependencies.attachSessionAndFact || attachSessionAndFact;
  await attach(db, body, identity, sessionId);
  const message = biteMessage(body, sessionId, hostId);
  const send = dependencies.sendBiteStage || sendBiteStage;
  await send(env, message);

  return {
    skipped: false,
    pending: true,
    stage: 'identity',
    ...identity,
    session_id: sessionId,
    host_id: hostId,
    bite_deferred: true,
  };
}

export async function processMinuteIdentityBite(
  env,
  body,
  dependencies = EMPTY_DEPENDENCIES,
) {
  const identity = identityFrom(body, IDENTITY_BITE_STAGE);
  const db = env?.MINUTE_DB;
  if (!db?.prepare && !dependencies.loadCurrentMinute) {
    throw new Error('MINUTE_DB binding is missing');
  }
  const loadCurrent = dependencies.loadCurrentMinute || loadCurrentMinute;
  const current = await loadCurrent(db, identity);
  if (staleWinner(current, identity)) {
    return { skipped: true, reason: 'stale-minute-winner', stage: IDENTITY_BITE_STAGE, ...identity };
  }

  const revisionId = integer(body.revision_id);
  const writeBite = dependencies.writeCurrentBite || writeCurrentBite;
  const biteCount = revisionId == null ? null : await writeBite(db, {
    channelId: identity.channelId,
    stationId: body.station_id,
    revisionId,
    position: integer(body.queue_position),
    trackId: integer(body.track_id),
    observedAt: identity.observedAt,
    queue: body.queue,
  });
  return {
    skipped: false,
    pending: false,
    stage: IDENTITY_BITE_STAGE,
    ...identity,
    session_id: integer(body.session_id),
    host_id: integer(body.host_id),
    bite_count: biteCount,
  };
}
