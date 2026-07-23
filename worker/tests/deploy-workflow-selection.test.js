import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const selector = fileURLToPath(new URL('../scripts/select-worker-deploys.mjs', import.meta.url));

test('deployment workflow changes redeploy all active Workers in dependency order', () => {
  const result = JSON.parse(execFileSync(process.execPath, [selector], {
    encoding: 'utf8',
    input: '.github/workflows/deploy-split-pipeline.yml\n',
  }));

  assert.deepEqual(result.workers, [
    'sh-sakurazaka46jp',
    'sh-buddies-collector',
    'sh-runtime-orchestrator',
  ]);
  assert.deepEqual(result.commands, [
    'deploy:sakurazaka46jp',
    'deploy:buddies-collector',
    'deploy:runtime',
  ]);
});
