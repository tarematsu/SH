import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  OFFICIAL_NEWS_STAGE_MESSAGE,
  officialNewsStageTask,
  processOfficialNewsStage,
} from '../src/other-official-news-stages.js';

const BASE = Date.UTC(2026, 0, 1, 0, 20, 0);

test('official-news probe queues reconciliation only after successful completion', async () => {
  const order = [];
  const sent = [];
  const result = await processOfficialNewsStage({ marker: true }, {
    stage: 'probe',
    scheduledAt: BASE,
  }, {
    config: () => ({ marker: 'config' }),
    probe: async (env, config, now) => {
      order.push('probe');
      assert.equal(env.marker, true);
      assert.equal(config.marker, 'config');
      assert.equal(now, BASE);
      return { skipped: false };
    },
    send: async (message) => {
      order.push('send');
      sent.push(message);
    },
  });

  assert.deepEqual(order, ['probe', 'send']);
  assert.equal(result.stage, 'probe');
  assert.equal(result.pending, true);
  assert.equal(sent[0].message_type, OFFICIAL_NEWS_STAGE_MESSAGE);
  assert.equal(sent[0].stage, 'reconcile');
  assert.equal(sent[0].scheduled_at, BASE);
});

test('official-news probe failure never queues reconciliation', async () => {
  let sent = false;
  const failure = new Error('probe failed');
  await assert.rejects(processOfficialNewsStage({}, {
    stage: 'probe',
    scheduledAt: BASE,
  }, {
    config: () => ({}),
    probe: async () => { throw failure; },
    send: async () => { sent = true; },
  }), failure);
  assert.equal(sent, false);
});

test('official-news reconciliation is an independent stage', async () => {
  const calls = [];
  const result = await processOfficialNewsStage({ marker: true }, {
    stage: 'reconcile',
    scheduledAt: BASE,
  }, {
    reconcile: async (env, now) => calls.push([env, now]),
  });
  assert.equal(result.stage, 'reconcile');
  assert.equal(result.pending, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0].marker, true);
  assert.equal(calls[0][1], BASE);
});

test('official-news task validation and monitor router retain one-message dispatch', () => {
  assert.deepEqual(officialNewsStageTask({
    message_type: OFFICIAL_NEWS_STAGE_MESSAGE,
    message_version: 1,
    stage: 'reconcile',
    scheduled_at: BASE,
  }), { stage: 'reconcile', scheduledAt: BASE });

  const source = readFileSync(new URL('../src/other-monitor-entry.js', import.meta.url), 'utf8');
  assert.match(source, /messageType === OFFICIAL_NEWS_STAGE_MESSAGE/);
  assert.match(source, /processOfficialNewsStageMessage/);
  assert.match(source, /const message = messages\[0\]/);
});
