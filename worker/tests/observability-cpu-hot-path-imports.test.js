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
const runtimeEntry = readFileSync(
  new URL('../src/runtime-orchestrator-entry.js', import.meta.url),
  'utf8',
);
const runtimeScheduled = readFileSync(
  new URL('../src/runtime-scheduled.js', import.meta.url),
  'utf8',
);
const liveCompleteMessage = readFileSync(
  new URL('../src/minute-live-complete-message.js', import.meta.url),
  'utf8',
);
const liveCompleteEntry = readFileSync(
  new URL('../src/minute-live-complete-budget-entry.js', import.meta.url),
  'utf8',
);
const liveTriggerEntry = readFileSync(
  new URL('../src/minute-live-trigger-budget-entry.js', import.meta.url),
  'utf8',
);
const minuteEnrichment = readFileSync(
  new URL('../src/minute-enrichment-optimized-entry.js', import.meta.url),
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

test('live derive fallback keeps budget stages available and the full graph lazy', () => {
  for (const moduleName of [
    'minute-live-trigger-budget-entry.js',
    'minute-live-revision-budget-entry.js',
    'minute-live-write-budget-entry.js',
    'minute-live-complete-budget-entry.js',
  ]) {
    assert.match(minutePipeline, new RegExp(`from './${moduleName.replaceAll('.', '\\.')}'`));
    assert.doesNotMatch(minutePipeline, new RegExp(`import\\('./${moduleName.replaceAll('.', '\\.')}'\\)`));
  }

  assert.match(minutePipeline, /budgetedLiveCompleteBatch/);
  assert.match(minutePipeline, /import\('\.\/minute-derive-entry\.js'\)/);
  assert.match(minutePipeline, /import\('\.\/minute-rebuild-batched-entry\.js'\)/);
  assert.match(runtimeConfig, /"LIVE_REVISION_MATERIALIZATION_ENABLED"\s*:\s*false/);
});

test('core queue routes recurring live stages before loading the shared runtime graph', () => {
  for (const moduleName of [
    'minute-live-trigger-budget-entry.js',
    'minute-live-revision-budget-entry.js',
    'minute-live-write-budget-entry.js',
    'minute-live-complete-budget-entry.js',
  ]) {
    assert.match(runtimeEntry, new RegExp(`import\\('./${moduleName.replaceAll('.', '\\.')}'\\)`));
    assert.doesNotMatch(runtimeEntry, new RegExp(`from './${moduleName.replaceAll('.', '\\.')}'`));
  }
  assert.match(runtimeEntry, /from '\.\/minute-live-complete-message\.js'/);
  assert.match(liveCompleteEntry, /from '\.\/minute-live-complete-message\.js'/);
  assert.doesNotMatch(liveCompleteMessage, /COMPLETE_LIVE_MINUTE_FACT_JOB_SQL/);
  assert.match(runtimeEntry, /lightweightLiveBudgetKind/);
  assert.match(runtimeEntry, /if \(liveKind\) return runLightweightLiveQueue/);
});

test('live trigger uses the narrow lease boundary instead of loading derive and inbox graphs', () => {
  assert.match(liveTriggerEntry, /from '\.\/minute-live-trigger-lease\.js'/);
  assert.doesNotMatch(liveTriggerEntry, /from '\.\/minute-derive-queue\.js'/);
  assert.doesNotMatch(liveTriggerEntry, /from '\.\/minute-facts-inbox\.js'/);
});

test('track metadata modules are loaded before metadata queue work', () => {
  assert.match(trackMetadata, /from '\.\/committed-metadata-enrichment\.js'/);
  assert.match(trackMetadata, /from '\.\/read-model-stages\.js'/);
  assert.doesNotMatch(trackMetadata, /import\('\.\/committed-metadata-enrichment\.js'\)/);
  assert.doesNotMatch(trackMetadata, /import\('\.\/read-model-stages\.js'\)/);
});

test('core router keeps queue, fetch and scheduled graphs behind their event routes', () => {
  for (const moduleName of [
    'ingest-channel-optimized-entry.js',
    'minute-enrichment-optimized-entry.js',
    'pages-read-model-entry.js',
    'runtime-queue.js',
    'runtime-scheduled.js',
  ]) {
    assert.match(runtimeEntry, new RegExp(`import\\('./${moduleName.replaceAll('.', '\\.')}'\\)`));
    assert.doesNotMatch(runtimeEntry, new RegExp(`from './${moduleName.replaceAll('.', '\\.')}'`));
  }
  assert.doesNotMatch(runtimeEntry, /from '\.\/ingest-channel-optimized-entry\.js'/);
  assert.doesNotMatch(runtimeEntry, /from '\.\/minute-enrichment-optimized-entry\.js'/);
});

test('Pipeline analytics stays outside Queue and fetch module graphs', () => {
  assert.match(runtimeScheduled, /import\('\.\/runtime-pipeline-analytics\.js'\)/);
  assert.doesNotMatch(runtimeScheduled, /from '\.\/runtime-pipeline-analytics\.js'/);
  assert.doesNotMatch(runtimeEntry, /runtime-pipeline-analytics\.js/);
});

test('Pages recurring stages preload only inside the Pages route', () => {
  assert.match(pagesReadModelEntry, /from '\.\/pages-read-model-dispatch\.js'/);
  assert.match(pagesReadModelEntry, /from '\.\/pages-track-history-publication-queue\.js'/);
  assert.doesNotMatch(pagesReadModelEntry, /import\('\.\/pages-read-model-dispatch\.js'\)/);
  assert.doesNotMatch(pagesReadModelEntry, /import\('\.\/pages-track-history-publication-queue\.js'\)/);
  assert.match(pagesReadModelDispatch, /from '\.\/pages-track-history-split-cycle\.js'/);
  assert.match(minuteEnrichment, /pagesModulePromise \|\|= import\('\.\/pages-read-model-entry\.js'\)/);
  assert.doesNotMatch(minuteEnrichment, /from '\.\/pages-read-model-entry\.js'/);
  assert.equal(JSON.parse(runtimeConfig).vars.PAGES_TRACK_HISTORY_ROWS_PER_STEP, 25);
});
