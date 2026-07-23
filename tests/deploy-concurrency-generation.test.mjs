import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(
  new URL('../.github/workflows/deploy-split-pipeline.yml', import.meta.url),
  'utf8',
);

test('production deployments use the current concurrency generation without cancellation', () => {
  assert.match(workflow, /group: deploy-production-minute-db-v2-generation-3/);
  assert.match(workflow, /cancel-in-progress: false/);
});
