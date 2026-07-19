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

test('maintenance recovery preserves durable job kind on derive triggers', async () => {
  let sql = '';
  let bindings = [];
  const rows = [
    { channel_id: 10, minute_at: 120_000, job_kind: 'live' },
    { channel_id: 10, minute_at: 60_000, job_kind: 'rebuild' },
  ];
  const MINUTE_DB = {
    prepare(value) {
      sql = value;
      return {
        bind(...values) { bindings = values; return this; },
        async all() { return { results: rows }; },
      };
    },
  };

  const triggers = await pendingMinuteDeriveTriggers({ MINUTE_DB }, { now: 200_000, limit: 2 });
  assert.match(sql, /SELECT channel_id,minute_at,job_kind/);
  assert.deepEqual(bindings, [200_000, 200_000, 2]);
  assert.deepEqual(triggers.map(({ job_kind }) => job_kind), ['live', 'rebuild']);
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
