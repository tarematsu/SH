import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(
  new URL('../.github/workflows/cloudflare-pr-diagnostics.yml', import.meta.url),
  'utf8',
);

test('PR diagnostics retain runtime deployment after test-only follow-up commits', () => {
  const fullRange = 'git diff --name-only "$BASE_SHA" "$HEAD_SHA"';
  assert.equal(workflow.split(fullRange).length - 1, 2);
  assert.doesNotMatch(workflow, /\$\{HEAD_SHA\}\^/);
  assert.match(workflow, /needs\.select-workers\.outputs\.runtime_changes == 'true'/);
});
