import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(
  new URL('../.github/workflows/cloudflare-pr-diagnostics.yml', import.meta.url),
  'utf8',
);

test('Cloudflare PR diagnostics record topology cutovers without waiting for connected builds', () => {
  assert.match(workflow, /needs\.select-workers\.outputs\.topology_rename == 'true'/);
  assert.match(workflow, /topology-rename-requires-serialized-cutover/);
  assert.match(workflow, /target_sha/);
  assert.match(workflow, /target_branch/);
  assert.match(workflow, /if-no-files-found: error/);
  assert.match(workflow, /include-hidden-files: true/);
  assert.doesNotMatch(workflow, /CLOUDFLARE_BUILD_TIMEOUT_MINUTES/);
  assert.doesNotMatch(workflow, /cloudflare-build-diagnostics\.mjs/);
  assert.doesNotMatch(workflow, /timeout-minutes: 10/);
});
