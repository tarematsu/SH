import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import worker from '../src/ingest-channel-optimized-entry.js';

const source = readFileSync(
  new URL('../src/ingest-channel-optimized-entry.js', import.meta.url),
  'utf8',
);

function occurrences(value) {
  return source.split(value).length - 1;
}

test('ingest entry resolves each lazy stage module only once in an isolate', () => {
  const modulePaths = [
    './ingest-prepared-channel.js',
    './queue-analysis-transfer.js',
    './snapshot-analysis-transfer.js',
    './raw-collection-preparation.js',
    './ingest-channel-entry.js',
    './ingest-fact-stage.js',
    './ingest-finalize-entry.js',
    './comments-cpu-entry.js',
    './persist-channel-optimized-entry.js',
  ];
  for (const modulePath of modulePaths) {
    assert.equal(occurrences(`import('${modulePath}')`), 1, modulePath);
  }

  for (const cache of [
    'preparedModulesPromise',
    'rawStagesPromise',
    'legacyIngestPromise',
    'ingestFactStagesPromise',
    'ingestFinalizePromise',
    'commentsModulePromise',
    'persistModulePromise',
  ]) {
    assert.match(source, new RegExp(`return ${cache} \\?\\?=`));
  }
});

test('comments Queue is delegated to the lazy comments wrapper with its own limits', async () => {
  const calls = [];
  const message = {
    body: { message_type: 'stationhead-comments-forward', message_version: 1 },
    ack() { calls.push('ack'); },
    retry() { calls.push('retry'); },
  };
  await worker.queue({ queue: 'stationhead-comments', messages: [message] }, {});
  assert.deepEqual(calls, ['retry']);
});

test('persist Queue is delegated to the lazy persistence wrapper', async () => {
  const calls = [];
  const message = {
    body: { message_type: 'unsupported-persistence-task' },
    ack() { calls.push('ack'); },
    retry() { calls.push('retry'); },
  };
  await worker.queue({ queue: 'stationhead-buddies-persist', messages: [message] }, {});
  assert.deepEqual(calls, ['retry']);
});

test('ingest queue keeps empty batches allocation-light and harmless', async () => {
  await worker.queue({ messages: [] }, {});
});

test('ingest failure routing avoids a transient membership array and repeated delay coercion', () => {
  assert.doesNotMatch(source, /\[.*stationhead-ingest-fact.*\]\.includes\(type\)/s);
  assert.equal(occurrences('Number(error?.retryDelaySeconds)'), 1);
  assert.equal(occurrences('const body = message.body;'), 1);
});
