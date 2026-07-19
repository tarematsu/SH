import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  enqueueMinuteDeriveTrigger,
  pendingMinuteDeriveTriggers,
} from '../src/minute-derive-trigger.js';

function config(name) {
  return JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'));
}

test('minute derive Worker consumes isolated live and rebuild queues', () => {
  const derive = config('wrangler.minute-derive.jsonc');
  assert.deepEqual(derive.queues.consumers.map(({ queue }) => queue), [
    'stationhead-minute-derive',
    'stationhead-minute-live-derive',
  ]);
  assert.deepEqual(derive.queues.consumers.map(({ max_concurrency }) => max_concurrency), [1, 2]);
  assert.equal(
    derive.queues.producers.find(({ binding }) => binding === 'MINUTE_LIVE_DERIVE_QUEUE').queue,
    'stationhead-minute-live-derive',
  );

  const entry = readFileSync(new URL('../src/minute-derive-entry.js', import.meta.url), 'utf8');
  assert.match(entry, /batch\?\.queue/);
  assert.match(entry, /MINUTE_LIVE_DERIVE_QUEUE/);
  assert.match(entry, /stationhead-minute-live-derive/);
});

test('new live facts prefer the empty live derive lane', async () => {
  const sent = [];
  const liveQueue = {
    async send(body, options) { sent.push({ lane: 'live', body, options }); },
  };
  const rebuildQueue = {
    async send(body, options) { sent.push({ lane: 'rebuild', body, options }); },
  };

  const trigger = await enqueueMinuteDeriveTrigger({
    MINUTE_LIVE_DERIVE_QUEUE: liveQueue,
    MINUTE_DERIVE_QUEUE: rebuildQueue,
  }, { channel_id: 10, minute_at: 120_000 });

  assert.equal(trigger.job_kind, 'live');
  assert.deepEqual(sent, [{
    lane: 'live',
    body: trigger,
    options: { contentType: 'json' },
  }]);
});

test('maintenance recovery scans pending and expired leases through separate indexed queries', async () => {
  const calls = [];
  const responses = [
    [
      { id: 4, channel_id: 10, minute_at: 120_000, job_kind: 'live', job_priority: 100 },
      { id: 5, channel_id: 10, minute_at: 180_000, job_kind: 'live', job_priority: 100 },
    ],
    [
      { id: 2, channel_id: 10, minute_at: 60_000, job_kind: 'rebuild', job_priority: 20 },
    ],
  ];
  const MINUTE_DB = {
    prepare(sql) {
      const call = { sql, bindings: [] };
      calls.push(call);
      return {
        bind(...values) { call.bindings = values; return this; },
        async all() { return { results: responses[calls.indexOf(call)] }; },
      };
    },
  };

  const triggers = await pendingMinuteDeriveTriggers({ MINUTE_DB }, { now: 200_000, limit: 2 });
  assert.equal(calls.length, 2);
  assert.match(calls[0].sql, /status='pending' AND next_attempt_at<=\?/);
  assert.match(calls[1].sql, /status='processing' AND lease_until<\?/);
  assert.doesNotMatch(calls.map(({ sql }) => sql).join('\n'), /\sOR\s/);
  assert.deepEqual(calls.map(({ bindings }) => bindings), [[200_000, 2], [200_000, 2]]);
  assert.deepEqual(triggers.map(({ job_kind }) => job_kind), ['live', 'live']);
});

test('all deploy paths provision the live derive queue and DLQ', () => {
  for (const path of [
    '../../.github/workflows/deploy.yml',
    '../../.github/workflows/deploy-split-pipeline.yml',
    '../../.github/workflows/cloudflare-pr-diagnostics.yml',
  ]) {
    const workflow = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.match(workflow, /stationhead-minute-live-derive stationhead-minute-live-derive-dlq/);
  }
});
