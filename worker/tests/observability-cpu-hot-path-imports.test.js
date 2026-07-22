import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const minutePipeline = readFileSync(
  new URL('../src/minute-pipeline-entry.js', import.meta.url),
  'utf8',
);
const trackMetadata = readFileSync(
  new URL('../src/track-metadata-entry.js', import.meta.url),
  'utf8',
);

test('live derive modules are loaded before queue invocations', () => {
  for (const moduleName of [
    'minute-derive-entry.js',
    'minute-live-trigger-budget-entry.js',
    'minute-live-revision-budget-entry.js',
    'minute-live-write-budget-entry.js',
  ]) {
    assert.match(minutePipeline, new RegExp(`from './${moduleName.replaceAll('.', '\\.')}'`));
    assert.doesNotMatch(minutePipeline, new RegExp(`import\\('./${moduleName.replaceAll('.', '\\.')}'\\)`));
  }

  assert.match(minutePipeline, /import\('\.\/minute-rebuild-batched-entry\.js'\)/);
});

test('track metadata modules are loaded before queue invocations', () => {
  assert.match(trackMetadata, /from '\.\/committed-metadata-enrichment\.js'/);
  assert.match(trackMetadata, /from '\.\/read-model-stages\.js'/);
  assert.doesNotMatch(trackMetadata, /import\('\.\/committed-metadata-enrichment\.js'\)/);
  assert.doesNotMatch(trackMetadata, /import\('\.\/read-model-stages\.js'\)/);
});
