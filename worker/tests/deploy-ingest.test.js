import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../scripts/deploy-runtime.mjs', import.meta.url), 'utf8');

test('core deployment verifies every migrated consumer and rolls back safely', () => {
  assert.match(source, /preparePagesReadModelDeployConfig/);
  assert.match(source, /pauseQueue\(migration\.queue\)/);
  assert.match(source, /removeConsumer\(migration\.queue, migration\.oldScript\)/);
  assert.match(source, /restoreConsumer\(migration\)/);
  assert.match(source, /resumeQueue\(queue\)/);
  assert.match(source, /runtime orchestrator consumer missing/);
  assert.match(source, /retired core consumer still attached/);
  assert.match(source, /stationhead-buddies-persist/);
  assert.match(source, /stationhead-minute-enrichment/);
  assert.match(source, /sh-buddies-ingest/);
  assert.match(source, /sh-minute-enrichment/);
  assert.match(source, /core_runtime_worker_deployed/);
});

test('Pages-bound legacy Worker retirement is deferred until Pages cutover', () => {
  assert.match(source, /DEFERRED_RETIREMENT_WORKERS = new Set\(\['sh-minute-enrichment'\]\)/);
  assert.match(source, /RETIRED_WORKER_NAMES\.filter/);
  assert.match(source, /!DEFERRED_RETIREMENT_WORKERS\.has\(name\)/);
  assert.match(source, /deferred_retired_scripts/);
  assert.doesNotMatch(source, /await pruneRetiredWorkers\(\);/);
});
