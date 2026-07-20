import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../scripts/deploy-ingest.mjs', import.meta.url), 'utf8');

test('ingest deployment verifies both consolidated consumers and rolls back safely', () => {
  assert.match(source, /runWrangler\(\['deploy', '--config', 'wrangler\.ingest\.jsonc'\]\)/);
  assert.match(source, /pauseQueue\(migration\.queue\)/);
  assert.match(source, /removeConsumer\(migration\.queue, migration\.oldScript\)/);
  assert.match(source, /restoreConsumer\(migration\)/);
  assert.match(source, /resumeQueue\(queue\)/);
  assert.match(source, /retired consumer still attached/);
  assert.match(source, /stationhead-buddies-persist/);
  assert.match(source, /sh-buddies-persist/);
  assert.match(source, /ingest_worker_consolidation_completed/);
});
