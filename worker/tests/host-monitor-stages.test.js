import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { processHostMonitorTask, runHostMonitorQueue } from '../src/host-monitor-entry.js';
import { processHostMonitorStage } from '../src/host-monitor-stages.js';

const BASE = Date.UTC(2026, 0, 1, 0, 50, 0);

function body(stage = null, extra = null) {
  return {
    message_type: 'host-monitor-task',
    message_version: 1,
    scheduled_at: BASE,
    observed_at: BASE,
    ...(stage ? { host_stage: stage } : {}),
    ...(extra || {}),
  };
}

test('host plan publishes profile and solo work as separate Queue invocations', async () => {
  const sent = [];
  const result = await processHostMonitorStage({}, {
    scheduledAt: BASE,
    observedAt: BASE,
    stage: 'plan',
    profile: null,
  }, {
    loadPlan: async () => ({ profileDue: true, soloDue: true }),
    send: async (message, delayed) => sent.push({ message, delayed }),
  });

  assert.equal(result.dispatched, 2);
  assert.deepEqual(sent.map(({ message }) => message.host_stage), ['profile-fetch', 'solo-run']);
  assert.equal(sent[0].delayed, false);
  assert.equal(sent[1].delayed, true);
});

test('profile fetch carries normalized data only to a durable persist stage', async () => {
  const sent = [];
  const profile = { handle: 'sakuramankai', account_id: 3334889 };
  const result = await processHostMonitorStage({}, {
    scheduledAt: BASE,
    observedAt: BASE,
    stage: 'profile-fetch',
    profile: null,
  }, {
    fetchProfile: async () => ({ profile, observedAt: BASE }),
    send: async (message, delayed) => sent.push({ message, delayed }),
  });

  assert.equal(result.pending, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message.host_stage, 'profile-persist');
  assert.equal(sent[0].message.profile, profile);
  assert.equal(sent[0].delayed, true);
});

test('profile persistence and solo execution remain independent stages', async () => {
  const profile = { handle: 'sakuramankai', account_id: 3334889 };
  const persisted = await processHostMonitorStage({}, {
    scheduledAt: BASE,
    observedAt: BASE,
    stage: 'profile-persist',
    profile,
  }, {
    persistProfile: async (_env, value, observedAt) => {
      assert.equal(value, profile);
      assert.equal(observedAt, BASE);
      return { accepted: true, duplicate: false };
    },
  });
  assert.equal(persisted.accepted, true);

  let soloEnv = null;
  const solo = await processHostMonitorStage({ marker: true }, {
    scheduledAt: BASE,
    observedAt: BASE,
    stage: 'solo-run',
    profile: null,
  }, {
    runSolo: async (env) => { soloEnv = env; },
  });
  assert.equal(solo.pending, false);
  assert.equal(soloEnv.marker, true);
  assert.equal(soloEnv.HOST_PROFILE_INTERVAL_MS, Number.MAX_SAFE_INTEGER);
});

test('dependency-injected direct host execution remains compatible', async () => {
  const calls = [];
  const result = await processHostMonitorTask({ marker: true }, body(), {
    run: async (env) => calls.push(env),
  });
  assert.equal(calls.length, 1);
  assert.equal(result.event, 'host_monitor_task_completed');
  assert.equal(result.stage, 'plan');
});

test('host Queue uses one-message dispatch and compact stage logs', async () => {
  const calls = [];
  await runHostMonitorQueue({
    messages: [{
      body: body('profile-persist', { profile: { handle: 'sakuramankai' } }),
      ack() { calls.push('ack'); },
      retry() { calls.push('retry'); },
    }],
  }, {}, {
    processStage: async () => ({ stage: 'profile-persist', accepted: true, duplicate: false }),
  });
  assert.deepEqual(calls, ['ack']);

  const source = readFileSync(new URL('../src/host-monitor-entry.js', import.meta.url), 'utf8');
  assert.match(source, /const message = messages\[0\]/);
  assert.match(source, /const RETRY_60_SECONDS = Object\.freeze/);
  assert.doesNotMatch(source, /for \(const message of batch/);
});
