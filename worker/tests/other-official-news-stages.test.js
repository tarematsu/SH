import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  OFFICIAL_NEWS_STAGE_MESSAGE,
  officialNewsStageTask,
  processOfficialNewsStage,
} from '../src/other-official-news-stages.js';

const BASE = Date.UTC(2026, 0, 1, 0, 20, 0);

function messageStage(stage) {
  return {
    message_type: OFFICIAL_NEWS_STAGE_MESSAGE,
    message_version: 1,
    stage,
    scheduled_at: BASE,
  };
}

test('legacy probe stage performs only the news check and queues station probe', async () => {
  const order = [];
  const sent = [];
  const result = await processOfficialNewsStage({ marker: true }, {
    stage: 'probe',
    scheduledAt: BASE,
  }, {
    config: () => ({ marker: 'config' }),
    check: async (env, config, now) => {
      order.push('check');
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

  assert.deepEqual(order, ['check', 'send']);
  assert.equal(result.stage, 'probe');
  assert.equal(result.next_stage, 'station-probe');
  assert.equal(result.pending, true);
  assert.equal(sent[0].stage, 'station-probe');
  assert.equal(sent[0].scheduled_at, BASE);
});

test('news check failure never queues the next stage for injected callers', async () => {
  let sent = false;
  const failure = new Error('check failed');
  await assert.rejects(processOfficialNewsStage({}, {
    stage: 'probe',
    scheduledAt: BASE,
  }, {
    config: () => ({}),
    check: async () => { throw failure; },
    send: async () => { sent = true; },
  }), failure);
  assert.equal(sent, false);
});

test('station probe is independent and queues reconciliation', async () => {
  const order = [];
  const sent = [];
  const result = await processOfficialNewsStage({ marker: true }, {
    stage: 'station-probe',
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
  assert.equal(result.stage, 'station-probe');
  assert.equal(result.next_stage, 'reconcile');
  assert.equal(sent[0].stage, 'reconcile');
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

test('official-news task validation preserves old probe messages and new station probe', () => {
  assert.deepEqual(officialNewsStageTask(messageStage('probe')), {
    stage: 'probe',
    scheduledAt: BASE,
  });
  assert.deepEqual(officialNewsStageTask(messageStage('station-probe')), {
    stage: 'station-probe',
    scheduledAt: BASE,
  });
  assert.deepEqual(officialNewsStageTask(messageStage('reconcile')), {
    stage: 'reconcile',
    scheduledAt: BASE,
  });

  const source = readFileSync(new URL('../src/other-monitor-entry.js', import.meta.url), 'utf8');
  assert.match(source, /messageType === OFFICIAL_NEWS_STAGE_MESSAGE/);
  assert.match(source, /processOfficialNewsStageMessage/);
  assert.match(source, /const message = messages\[0\]/);
});
