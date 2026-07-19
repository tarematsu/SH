import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { dispatchPendingMinuteFacts } from '../src/minute-maintenance-entry.js';

test('minute maintenance caches lazy modules and avoids merged dispatch arrays', () => {
  const source = readFileSync(new URL('../src/minute-maintenance-entry.js', import.meta.url), 'utf8');

  assert.match(source, /deriveDispatchStateDependenciesPromise \|\|=/);
  assert.match(source, /cronStaggerModulePromise \|\|=/);
  assert.doesNotMatch(source, /\[\.\.\.triggers,\s*\.\.\.revisionRecoveries\]/);
  assert.doesNotMatch(source, /messages\.map\(/);
  assert.match(source, /new Array\(messageCount\)/);
});

test('minute maintenance fallback sends preserve trigger and recovery order', async () => {
  const sent = [];
  const trigger = { message_type: 'minute-fact-derive', job_id: 'minute-fact:10:120000' };
  const recovery = {
    message_type: 'minute-fact-derive-stage',
    stage: 'revision-materialize',
    revision: { revision_id: 60 },
  };
  const marked = [];

  const summary = await dispatchPendingMinuteFacts({
    MINUTE_DERIVE_QUEUE: {
      async send(body, options) {
        sent.push({ body, options });
      },
    },
  }, {
    load: async () => [trigger],
    loadRevisionRecovery: async () => [recovery],
    markRevisionRecovery: async (_env, ids) => marked.push(...ids),
  });

  assert.deepEqual(sent, [
    { body: trigger, options: { contentType: 'json' } },
    { body: recovery, options: { contentType: 'json' } },
  ]);
  assert.deepEqual(marked, [60]);
  assert.equal(summary.dispatched, 1);
  assert.equal(summary.revision_recoveries, 1);
  assert.equal(summary.live_messages, 2);
  assert.equal(summary.rebuild_messages, 0);
});

test('minute maintenance isolates live work from rebuild backlog', async () => {
  const live = [];
  const rebuild = [];
  const liveTrigger = {
    message_type: 'minute-fact-derive',
    job_id: 'minute-fact:10:180000',
    job_kind: 'live',
  };
  const rebuildTrigger = {
    message_type: 'minute-fact-derive',
    job_id: 'minute-fact:10:60000',
    job_kind: 'rebuild',
  };
  const liveRecovery = {
    message_type: 'minute-fact-derive-stage',
    stage: 'revision-materialize',
    job: { job_kind: 'live' },
    revision: { revision_id: 61 },
  };
  const rebuildRecovery = {
    message_type: 'minute-fact-derive-stage',
    stage: 'revision-materialize',
    job: { job_kind: 'rebuild' },
    revision: { revision_id: 62, rebuild: true },
  };

  const summary = await dispatchPendingMinuteFacts({
    MINUTE_LIVE_DERIVE_QUEUE: {
      async send(body) { live.push(body); },
    },
    MINUTE_DERIVE_QUEUE: {
      async send(body) { rebuild.push(body); },
    },
  }, {
    load: async () => [liveTrigger, rebuildTrigger],
    loadRevisionRecovery: async () => [liveRecovery, rebuildRecovery],
    markRevisionRecovery: async () => {},
  });

  assert.deepEqual(live, [liveTrigger, liveRecovery]);
  assert.deepEqual(rebuild, [rebuildTrigger, rebuildRecovery]);
  assert.equal(summary.live_messages, 2);
  assert.equal(summary.rebuild_messages, 2);
});
