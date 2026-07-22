import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const minutePipeline = readFileSync(
  new URL('../src/minute-pipeline-entry.js', import.meta.url),
  'utf8',
);
const runtimeConfig = readFileSync(
  new URL('../wrangler.runtime.jsonc', import.meta.url),
  'utf8',
);
const trackMetadata = readFileSync(
  new URL('../src/track-metadata-entry.js', import.meta.url),
  'utf8',
);
const pagesReadModelEntry = readFileSync(
  new URL('../src/pages-read-model-entry.js', import.meta.url),
  'utf8',
);
const pagesReadModelDispatch = readFileSync(
  new URL('../src/pages-read-model-dispatch.js', import.meta.url),
  'utf8',
);
const minuteEnrichmentConfig = readFileSync(
  new URL('../wrangler.minute-enrichment.jsonc', import.meta.url),
  'utf8',
);

test('live derive uses preloaded budget stages and keeps the full graph lazy', () => {
  for (const moduleName of [
    'minute-live-trigger-budget-entry.js',
    'minute-live-revision-budget-entry.js',
    'minute-live-write-budget-entry.js',
  ]) {
    assert.match(minutePipeline, new RegExp(`from './${moduleName.replaceAll('.', '\\.')}'`));
    assert.doesNotMatch(minutePipeline, new RegExp(`import\\('./${moduleName.replaceAll('.', '\\.')}'\\)`));
  }

  assert.match(minutePipeline, /import\('\.\/minute-derive-entry\.js'\)/);
  assert.match(minutePipeline, /import\('\.\/minute-rebuild-batched-entry\.js'\)/);
  assert.match(runtimeConfig, /"LIVE_REVISION_MATERIALIZATION_ENABLED"\s*:\s*false/);
});

test('track metadata modules are loaded before queue invocations', () => {
  assert.match(trackMetadata, /from '\.\/committed-metadata-enrichment\.js'/);
  assert.match(trackMetadata, /from '\.\/read-model-stages\.js'/);
  assert.doesNotMatch(trackMetadata, /import\('\.\/committed-metadata-enrichment\.js'\)/);
  assert.doesNotMatch(trackMetadata, /import\('\.\/read-model-stages\.js'\)/);
});

test('minute enrichment preloads recurring Pages CPU stages', () => {
  assert.match(pagesReadModelEntry, /from '\.\/pages-read-model-dispatch\.js'/);
  assert.match(pagesReadModelEntry, /from '\.\/pages-track-history-publication-queue\.js'/);
  assert.doesNotMatch(pagesReadModelEntry, /import\('\.\/pages-read-model-dispatch\.js'\)/);
  assert.doesNotMatch(pagesReadModelEntry, /import\('\.\/pages-track-history-publication-queue\.js'\)/);
  assert.match(pagesReadModelDispatch, /from '\.\/pages-track-history-split-cycle\.js'/);
  assert.doesNotMatch(pagesReadModelDispatch, /import\('\.\/pages-track-history-split-cycle\.js'\)/);
  assert.equal(JSON.parse(minuteEnrichmentConfig).vars.PAGES_TRACK_HISTORY_ROWS_PER_STEP, 10);
});
