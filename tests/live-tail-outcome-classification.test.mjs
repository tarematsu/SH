import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));

test('live-tail success outcomes are not classified as errors', () => {
  const result = spawnSync(process.execPath, [
    '.github/scripts/capture-cloudflare-live-tail.mjs',
    '--self-test',
  ], {
    cwd: root,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /classification self-test passed/);
});
