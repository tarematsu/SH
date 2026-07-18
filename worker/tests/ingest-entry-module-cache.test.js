import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import worker from '../src/ingest-channel-optimized-entry.js';

const source = readFileSync(
  new URL('../src/ingest-channel-optimized-entry.js', import.meta.url),
  'utf8',
);
const preparedRuntimeSource = readFileSync(
  new URL('../src/ingest-prepared-runtime.js', import.meta.url),
  'utf8',
);

function occurrences(text, value) {
  return text.split(value).length - 1;
}

test('ingest entry resolves each lazy stage module only once in an isolate', () => {
  const modulePaths = [
    './ingest-prepared-runtime.js',
    './raw-collection-preparation.js',
    './ingest-channel-entry.js',
    './ingest-fact-stage.js',
    './ingest-finalize-entry.js',
  ];
  for (const modulePath of modulePaths) {
    assert.equal(occurrences(source, `import('${modulePath}')`), 1, modulePath);
  }

  for (const cache of [
    'preparedRuntimePromise',
    'rawStagesPromise',
    'legacyIngestPromise',
    'ingestFactStagesPromise',
    'ingestFinalizePromise',
  ]) {
    assert.match(source, new RegExp(`return ${cache} \\?\\?=`));
  }
});

test('prepared ingest cold path uses one lazy import and one runtime dispatch', () => {
  assert.doesNotMatch(source, /Promise\.all/);
  assert.equal(occurrences(source, "import('./ingest-prepared-runtime.js')"), 1);
  assert.equal(occurrences(preparedRuntimeSource, "from './ingest-prepared-channel.js'"), 1);
  assert.equal(occurrences(preparedRuntimeSource, "from './queue-analysis-transfer.js'"), 1);
  assert.equal(occurrences(preparedRuntimeSource, "from './snapshot-analysis-transfer.js'"), 1);
  assert.match(preparedRuntimeSource, /return ingestPreparedRawCollection\(env, message\);/);
});

test('ingest queue keeps empty batches allocation-light and harmless', async () => {
  await worker.queue({ messages: [] }, {});
});

test('ingest failure routing avoids a transient membership array and repeated delay coercion', () => {
  assert.doesNotMatch(source, /\[.*stationhead-ingest-fact.*\]\.includes\(type\)/s);
  assert.equal(occurrences(source, 'Number(error?.retryDelaySeconds)'), 1);
  assert.equal(occurrences(source, 'const body = message.body;'), 1);
});
