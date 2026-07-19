import assert from 'node:assert/strict';
import test from 'node:test';

import {
  IDENTITY_BITE_STAGE,
  processMinuteIdentityBite,
  processMinuteIdentitySession,
} from '../src/minute-enrichment-identity-stages.js';
import { processOptimizedMinuteEnrichment } from '../src/minute-enrichment-optimized-entry.js';

function identityBody(stage = 'identity') {
  return {
    message_type: 'minute-fact-enrichment',
    message_version: 1,
    stage,
    channel_id: 10,
    station_id: 20,
    minute_at: 120_000,
    observed_at: 125_000,
    provisional_session_id: 25,
    revision_id: 30,
    host_account_id: 40,
    host_handle: 'host',
    broadcast_start_time: 60_000,
    is_broadcasting: 1,
    queue_position: 2,
    track_id: 300,
    queue: {
      queue_id: 50,
      start_time: 60_000,
      tracks: [{ position: 2, bite_count: 9, apple_music_id: 'removed' }],
    },
  };
}

test('identity session work commits context then defers bite work', async () => {
  const body = identityBody();
  const events = [];
  let sent = null;
  const result = await processMinuteIdentitySession({ MINUTE_DB: {} }, body, {
    loadCurrentMinute: async () => ({ observed_at: body.observed_at }),
    resolveHost: async () => { events.push('host'); return 41; },
    resolveSession: async () => { events.push('session'); return 26; },
    attachSessionAndFact: async () => { events.push('attach'); },
    sendBiteStage: async (_env, message) => { events.push('send'); sent = message; },
  });

  assert.deepEqual(events, ['host', 'session', 'attach', 'send']);
  assert.equal(result.pending, true);
  assert.equal(result.bite_deferred, true);
  assert.equal(result.session_id, 26);
  assert.equal(sent.stage, IDENTITY_BITE_STAGE);
  assert.equal(sent.session_id, 26);
  assert.equal(sent.host_id, 41);
  assert.equal(Object.hasOwn(sent, 'host_handle'), false);
});

test('identity bite stage performs only the canonical counter write', async () => {
  const body = {
    ...identityBody(IDENTITY_BITE_STAGE),
    session_id: 26,
    host_id: 41,
  };
  let input = null;
  const result = await processMinuteIdentityBite({ MINUTE_DB: {} }, body, {
    loadCurrentMinute: async () => ({ observed_at: body.observed_at }),
    writeCurrentBite: async (_db, value) => { input = value; return 9; },
  });

  assert.equal(result.pending, false);
  assert.equal(result.bite_count, 9);
  assert.equal(result.session_id, 26);
  assert.equal(input.revisionId, 30);
  assert.equal(input.position, 2);
  assert.equal(input.trackId, 300);
});

test('both identity stages reject an older minute winner before mutation', async () => {
  let mutations = 0;
  const stale = async () => ({ observed_at: 126_000 });
  const session = await processMinuteIdentitySession({ MINUTE_DB: {} }, identityBody(), {
    loadCurrentMinute: stale,
    resolveHost: async () => { mutations += 1; },
  });
  const bite = await processMinuteIdentityBite({ MINUTE_DB: {} }, identityBody(IDENTITY_BITE_STAGE), {
    loadCurrentMinute: stale,
    writeCurrentBite: async () => { mutations += 1; },
  });
  assert.equal(session.reason, 'stale-minute-winner');
  assert.equal(bite.reason, 'stale-minute-winner');
  assert.equal(mutations, 0);
});

test('optimized router sends production identity through the split stages', async () => {
  const body = identityBody();
  let sessionCalls = 0;
  let biteCalls = 0;
  await processOptimizedMinuteEnrichment({}, body, {
    processMinuteIdentitySession: async (_env, value) => {
      sessionCalls += 1;
      assert.equal(value.queue.tracks[0].apple_music_id, undefined);
      return { stage: 'identity', pending: true };
    },
  });
  await processOptimizedMinuteEnrichment({}, {
    ...body,
    stage: IDENTITY_BITE_STAGE,
  }, {
    processMinuteIdentityBite: async (_env, value) => {
      biteCalls += 1;
      assert.equal(value.queue.tracks[0].apple_music_id, undefined);
      return { stage: IDENTITY_BITE_STAGE, pending: false };
    },
  });
  assert.equal(sessionCalls, 1);
  assert.equal(biteCalls, 1);
});
