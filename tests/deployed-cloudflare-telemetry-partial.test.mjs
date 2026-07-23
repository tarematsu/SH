import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const rootPath = fileURLToPath(new URL('../', import.meta.url));

test('deployed telemetry audit preserves healthy Workers when one deployment is missing', () => {
  const result = spawnSync('python3', [
    '.github/scripts/audit-deployed-cloudflare-telemetry.py',
    '--self-test',
  ], {
    cwd: rootPath,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /deployed telemetry audit self-test passed/);
});
