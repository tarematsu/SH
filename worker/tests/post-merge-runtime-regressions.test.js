import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { snapshotPersistenceDue } from '../src/collector-ingest.js';
import { compactMaterializeMessage } from '../src/ingest-channel-optimized-entry.js';
import {
  activeDeriveEnv,
  LIVE_DERIVE_QUEUE_NAME,
  processMinuteDeriveBatch,
  REBUILD_DERIVE_QUEUE_NAME,
  refreshSparseRevisionContinuation,
  retireUnavailableRevisionSource,
  shouldLogMinuteDeriveResult,
  staleUnavailableRevisionSource,
  transientQueueOverload,
} from '../src/minute-derive-entry.js';
import { runPagesReadModelQueue } from '../src/pages-read-model-entry.js';

const MINUTE = 60_000;

function config(name) {
  return JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'));
}

test('consolidated Pages route handles minute read-model messages even when batch.queue is absent', async () => {
  const events = [];
  const message = {
    body: {
      message_type: 'stationhead-read-model',
      message_version: 1,
      job_id: 'read-model:1:2',
      read_model: {
        queue: {
          value: {
            tracks: [{ title: null, artist: null, album_name: null, thumbnail_url: null }],
          },
        },
      },
    },
    ack() { events.push('ack'); },
    retry() { events.push('retry'); },
  };

  await runPagesReadModelQueue({ messages: [message] }, {
    TRACK_METADATA_QUEUE: {
      async send() { events.push('metadata'); },
    },
  });

  assert.deepEqual(events, ['metadata', 'ack']);
});

test('optional comments are bounded inside the dedicated collector ingest route', () => {
  const collector = config('wrangler.buddies-collector.jsonc');
  const runtime = config('wrangler.runtime.jsonc');
  const entry = readFileSync(new URL('../src/ingest-channel-optimized-entry.js', import.meta.url), 'utf8');
  const comments = collector.queues.consumers.find(({ queue }) => queue === 'stationhead-comments');
  assert.equal(collector.vars.COMMENT_CHAIN_MAX_ATTEMPTS, 1);
  assert.equal(comments.max_batch_size, 1);
  assert.equal(comments.max_concurrency, 1);
  assert.equal(runtime.queues.consumers.some(({ queue }) => queue === 'stationhead-comments'), false);
  assert.match(entry, /CHAT_LIMIT: \{ value: 25/);
});

test('ingest persists operational snapshots once per twenty-minute slot', () => {
  const env = { SNAPSHOT_PERSIST_INTERVAL_MS: 20 * MINUTE };
  const boundary = Date.UTC(2026, 0, 1, 0, 20, 0);
  assert.equal(snapshotPersistenceDue(env, boundary), true);
  assert.equal(snapshotPersistenceDue(env, boundary + MINUTE), false);
  assert.equal(snapshotPersistenceDue({}, boundary + MINUTE), true);

  const collector = config('wrangler.buddies-collector.jsonc');
  assert.equal(collector.vars.SNAPSHOT_PERSIST_INTERVAL_MS, 20 * MINUTE);
});

test('ingest drops duplicate collected metadata when the dedicated pipeline owns hydration', () => {
  const body = {
    message_type: 'stationhead-raw-materialize',
    track_metadata: [{ spotify_id: 'track-1', title: 'title' }],
    queue: { tracks: [{ spotify_id: 'track-1' }] },
  };
  const compact = compactMaterializeMessage({ COLLECTED_METADATA_PERSIST_ENABLED: false }, body);
  assert.notEqual(compact, body);
  assert.deepEqual(compact.track_metadata, []);
  assert.equal(compact.queue, body.queue);
  assert.equal(compactMaterializeMessage({ COLLECTED_METADATA_PERSIST_ENABLED: true }, body), body);
});

test('live derive stays at one track while rebuild keeps the configured batch', async () => {
  const calls = [];
  const liveQueue = { async send(value) { calls.push(['live', value]); } };
  const rebuildQueue = { async send(value) { calls.push(['rebuild', value]); } };
  const env = {
    DERIVE_REVISION_CHUNK_TRACKS: 2,
    MINUTE_LIVE_DERIVE_QUEUE: liveQueue,
    MINUTE_DERIVE_QUEUE: rebuildQueue,
  };
  const live = activeDeriveEnv({ queue: LIVE_DERIVE_QUEUE_NAME }, env);
  const rebuild = activeDeriveEnv({ queue: REBUILD_DERIVE_QUEUE_NAME }, env);
  assert.equal(live.DERIVE_REVISION_CHUNK_TRACKS, 1);
  assert.equal(rebuild.DERIVE_REVISION_CHUNK_TRACKS, 2);
  await live.MINUTE_DERIVE_QUEUE.send({ id: 1 });
  await rebuild.MINUTE_DERIVE_QUEUE.send({ id: 2 });
  assert.deepEqual(calls, [
    ['live', { id: 1 }],
    ['rebuild', { id: 2 }],
  ]);
});

test('stale sparse revision continuations refresh from durable revision progress', async () => {
  const sent = [];
  const body = {
    message_type: 'minute-fact-derive-stage',
    message_version: 1,
    stage: 'revision-materialize',
    revision: {
      revision_id: 860,
      source_job_id: 10,
      visible_item_count: 5,
      total_item_count: 20,
      materialized_item_count: 2,
    },
  };
  const statement = {
    bind() { return this; },
    async first() {
      return {
        source_job_id: 11,
        source_visible_count: 8,
        item_count: 20,
        materialized_item_count: 4,
        coverage_complete: 0,
      };
    },
  };
  assert.equal(await refreshSparseRevisionContinuation({
    MINUTE_DB: { prepare: () => statement },
    MINUTE_DERIVE_QUEUE: { async send(value, options) { sent.push({ value, options }); } },
  }, body), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].value.revision.source_job_id, 11);
  assert.equal(sent[0].value.revision.visible_item_count, 8);
  assert.equal(sent[0].value.revision.materialized_item_count, 4);
  assert.deepEqual(sent[0].options, { contentType: 'json', delaySeconds: 1 });
});

test('unrecoverable sparse revision sources become terminal partial revisions after the grace window', async () => {
  const now = 1_000_000;
  const body = {
    message_type: 'minute-fact-derive-stage',
    message_version: 1,
    stage: 'revision-materialize',
    started_at: now - 6 * MINUTE,
    revision: {
      revision_id: 559,
      source_job_id: 99,
      visible_item_count: 8,
      materialized_item_count: 3,
    },
  };
  assert.equal(staleUnavailableRevisionSource(body, now), true);
  assert.equal(staleUnavailableRevisionSource({ ...body, started_at: now - MINUTE }, now), false);

  const calls = [];
  const statement = {
    bind(...args) { calls.push(['bind', args]); return this; },
    async run() { calls.push(['run']); return { meta: { changes: 1 } }; },
  };
  const retired = await retireUnavailableRevisionSource({
    MINUTE_DB: { prepare(sql) { calls.push(['sql', sql]); return statement; } },
  }, body, now);
  assert.equal(retired, true);
  assert.match(calls[0][1], /source_visible_count=COALESCE\(materialized_item_count,0\)/);
  assert.match(calls[0][1], /coverage_complete=CASE/);
  assert.deepEqual(calls[1], ['bind', [now, 559, 99, 8]]);
});

test('stale unavailable revision messages are acknowledged after terminalization', async () => {
  const events = [];
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (value) => warnings.push(String(value));
  try {
    await processMinuteDeriveBatch({
      queue: LIVE_DERIVE_QUEUE_NAME,
      messages: [{
        body: {
          message_type: 'minute-fact-derive-stage',
          message_version: 1,
          stage: 'revision-materialize',
          revision: { revision_id: 559, source_job_id: 99, materialized_item_count: 3 },
        },
        ack() { events.push('ack'); },
        retry() { events.push('retry'); },
      }],
    }, {
      MINUTE_DB: {},
      MINUTE_DERIVE_QUEUE: {},
    }, {
      async processMessage() {
        throw new Error('queue revision 559 source payload is unavailable or incomplete');
      },
      async refreshContinuation() { return false; },
      async retireUnavailableSource() { return true; },
    });
  } finally {
    console.warn = originalWarn;
  }
  assert.deepEqual(events, ['ack']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /minute_derive_revision_source_retired/);
});

test('Queue overload errors are transient retry warnings', () => {
  assert.equal(transientQueueOverload(new Error('Queue is overloaded. Please back off. (10250)')), true);
  assert.equal(transientQueueOverload(new Error('database schema is invalid')), false);
});

test('minute derive success logs are sampled but failures are always retained', () => {
  assert.equal(shouldLogMinuteDeriveResult({ job_id: 16, failed: 0 }), true);
  assert.equal(shouldLogMinuteDeriveResult({ job_id: 17, failed: 0 }), false);
  assert.equal(shouldLogMinuteDeriveResult({ job_id: 17, failed: 1 }), true);
});
