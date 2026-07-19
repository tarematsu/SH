import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { runBuddyPlaybackQueue } from '../src/buddy-playback-entry.js';
import {
  BUDDY_FETCH_COMPUTE_STAGE,
  processBuddyFetchCompute,
} from '../src/buddy-playback-fetch-stages.js';

function statement(sql, state) {
  return {
    params: [],
    bind(...params) {
      this.params = params;
      return this;
    },
    async first() {
      if (sql.includes('LEFT JOIN sh_worker_collector_state')) {
        return {
          channel_alias: 'buddy46',
          cycle_at: 1_800_000,
          stage: 'fetch',
          next_attempt_at: 0,
          lease_until: 1_900_000,
          auth_token: 'token',
          device_uid: 'device',
          token_expires_at: 0,
        };
      }
      throw new Error(`unexpected first SQL: ${sql}`);
    },
    async run() {
      state.runs.push({ sql, params: this.params });
      return { meta: { changes: 1 } };
    },
  };
}

test('Stationhead not-in-database response aborts the durable cycle without retry backoff', async () => {
  const state = { runs: [] };
  const result = await processBuddyFetchCompute({
    BUDDY_PLAYBACK_AUTH_STATE_ID: 'buddy46',
    OTHER_DB: { prepare(sql) { return statement(sql, state); } },
  }, {
    channelAlias: 'buddy46',
    cycleAt: 1_800_000,
    observedAt: 1_800_456,
  }, {
    fetchText: async () => {
      throw new Error('Stationhead buddy staged playback API 404: {"error":{"detail":"Not in database"}}');
    },
  });

  assert.deepEqual(result, {
    skipped: true,
    reason: 'station-not-found',
    pending: false,
    cycle_at: 1_800_000,
    channel_alias: 'buddy46',
  });
  assert.equal(state.runs.some(({ sql }) => sql.startsWith('DELETE FROM sh_buddy_playback_pipeline')), true);
  assert.equal(state.runs.some(({ sql }) => sql.includes('next_attempt_at=?,lease_until=0')), false);
});

test('absent buddy station is acknowledged as a benign Queue result', async () => {
  const calls = [];
  const logs = [];
  const originalLog = console.log;
  console.log = (value) => logs.push(String(value));
  try {
    await runBuddyPlaybackQueue({
      messages: [{
        body: {
          message_type: 'buddy-playback-stage',
          message_version: 1,
          scheduled_at: 1_800_000,
          observed_at: 1_800_456,
          channel_alias: 'buddy46',
          cycle_at: 1_800_000,
          direct_stage: BUDDY_FETCH_COMPUTE_STAGE,
        },
        ack() { calls.push('ack'); },
        retry() { calls.push('retry'); },
      }],
    }, {}, {
      fetchCompute: async () => ({
        skipped: true,
        reason: 'station-not-found',
        pending: false,
        cycle_at: 1_800_000,
      }),
    });
  } finally {
    console.log = originalLog;
  }

  assert.deepEqual(calls, ['ack']);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /"event":"buddy_playback_stage_completed"/);
  assert.match(logs[0], /"reason":"station-not-found"/);
});

test('monitor deployment retires the orphaned buddies read-model Worker', () => {
  const source = readFileSync(new URL('../scripts/deploy-other-monitor.mjs', import.meta.url), 'utf8');
  assert.match(source, /'sh-buddies-read-model'/);
  assert.match(source, /for \(const scriptName of retiredScripts\) await deleteOldWorker\(scriptName\)/);
});
