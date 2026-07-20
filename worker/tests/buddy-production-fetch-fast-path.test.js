import assert from 'node:assert/strict';
import test from 'node:test';

import { processBuddyPlaybackStage } from '../src/buddy-playback-entry.js';
import { BUDDY_FETCH_COMPUTE_STAGE } from '../src/buddy-playback-fetch-stages.js';

function pipelineRow(overrides = {}) {
  return {
    channel_alias: 'buddy46',
    cycle_at: 1_800_000,
    stage: 'fetch',
    next_attempt_at: 0,
    lease_until: 0,
    updated_at: 1_800_123,
    ...overrides,
  };
}

test('production buddy plan tries persisted credentials before auth refresh', async () => {
  let inserted = false;
  const sent = [];
  const env = {
    BUDDY_PLAYBACK_ENABLED: true,
    BUDDY_PLAYBACK_INTERVAL_MS: 1_800_000,
    BUDDY_PLAYBACK_QUEUE: {
      async send(body, options) { sent.push({ body, options }); },
    },
    OTHER_DB: {
      prepare(sql) {
        return {
          params: [],
          bind(...params) { this.params = params; return this; },
          async run() {
            if (sql.includes('INSERT OR IGNORE INTO sh_buddy_playback_pipeline')) inserted = true;
            return { meta: { changes: 1 } };
          },
          async first() {
            if (sql.includes('SELECT channel_alias,cycle_at')) {
              return inserted ? pipelineRow() : null;
            }
            if (sql.includes('RETURNING channel_alias,cycle_at')) {
              return pipelineRow({ lease_until: 1_890_123 });
            }
            throw new Error(`unexpected SQL: ${sql}`);
          },
        };
      },
    },
  };

  const result = await processBuddyPlaybackStage(env, {
    message_type: 'buddy-playback-stage',
    message_version: 1,
    scheduled_at: 1_800_000,
    observed_at: 1_800_123,
  });

  assert.equal(result.requeued, true);
  assert.equal(result.direct_stage, BUDDY_FETCH_COMPUTE_STAGE);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.direct_stage, BUDDY_FETCH_COMPUTE_STAGE);
  assert.equal(sent[0].body.cycle_at, 1_800_000);
  assert.deepEqual(sent[0].options, { contentType: 'json', delaySeconds: 1 });
});
