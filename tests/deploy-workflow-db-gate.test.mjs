import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(
  new URL('../.github/workflows/deploy-split-pipeline.yml', import.meta.url),
  'utf8',
);

test('deployment workflow changes redeploy Workers without forcing MINUTE_DB verification', () => {
  const minuteDbCondition = workflow.match(/if grep -Eq '([^']+)' changed-files\.txt; then\n\s+minute_db=true/)?.[1] || '';
  assert.match(minuteDbCondition, /\.github\/workflows\/database/);
  assert.doesNotMatch(minuteDbCondition, /deploy-split-pipeline/);
});
