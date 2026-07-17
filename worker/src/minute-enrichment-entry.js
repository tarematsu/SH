import {
  MINUTE_FACT_SOURCE_CODES,
  resolveHost,
  resolveLiveSession,
} from './minute-facts-store.js';
import { integer } from './minute-facts-track-descriptor.js';
import { writeCurrentBite } from './minute-facts-legacy-revision.js';

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
  return { channelId, minuteAt, observedAt };
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

export async function processMinuteEnrichment(env, body) {
  const identity = validateTask(body);
  const db = env?.MINUTE_DB;
  if (!db?.prepare) throw new Error('MINUTE_DB binding is missing');

  // An older retried task must not rewrite a newer minute-fact winner.
  const current = await db.prepare(`SELECT observed_at FROM sh_minute_facts
    WHERE channel_id=? AND minute_at=? LIMIT 1`)
    .bind(identity.channelId, identity.minuteAt).first();
  if (integer(current?.observed_at) !== identity.observedAt) {
    return { skipped: true, reason: 'stale-minute-winner', ...identity };
  }

  const hostId = await resolveHost(db, {
    accountId: body.host_account_id,
    handle: body.host_handle,
  }, identity.observedAt);
  const sessionId = await resolveOrderedSession(db, body, identity, hostId);
  await attachSession(db, body, identity, sessionId);

  const revisionId = integer(body.revision_id);
  const position = integer(body.queue_position);
  const trackId = integer(body.track_id);
  const biteCount = revisionId == null ? null : await writeCurrentBite(db, {
    channelId: identity.channelId,
    stationId: body.station_id,
    revisionId,
    position,
    trackId,
    observedAt: identity.observedAt,
    queue: body.queue,
  });

  await db.prepare(`UPDATE sh_minute_facts SET
      broadcast_session_id=COALESCE(?,broadcast_session_id),
      host_id=COALESCE(?,host_id),
      track_bite_count=COALESCE(?,track_bite_count)
    WHERE channel_id=? AND minute_at=? AND observed_at=? AND source_code=?`)
    .bind(
      sessionId,
      hostId,
      biteCount,
      identity.channelId,
      identity.minuteAt,
      identity.observedAt,
      MINUTE_FACT_SOURCE_CODES.live_collector,
    ).run();

  return {
    skipped: false,
    ...identity,
    session_id: sessionId,
    host_id: hostId,
    bite_count: biteCount,
  };
}

export default {
  async queue(batch, env) {
    for (const message of batch.messages || []) {
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
    }
  },
  fetch() {
    return Response.json({ ok: false, error: 'not found' }, { status: 404 });
  },
};
