import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(
  new URL('../.github/workflows/deploy-split-pipeline.yml', import.meta.url),
  'utf8',
);

test('Pages dependency installation reads the Pages cache result', () => {
  const pages = workflow.slice(workflow.indexOf('  pages:\n'));
  assert.match(pages, /id: pages-modules/);
  assert.match(pages, /if: steps\.pages-modules\.outputs\.cache-hit != 'true'/);
  assert.doesNotMatch(pages, /steps\.worker-modules\.outputs\.cache-hit/);
});
