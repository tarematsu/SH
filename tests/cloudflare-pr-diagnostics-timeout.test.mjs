import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(
  new URL('../.github/workflows/cloudflare-pr-diagnostics.yml', import.meta.url),
  'utf8',
);

test('Cloudflare PR diagnostics poll only when a topology rename prevents direct deploy', () => {
  assert.match(workflow, /timeout-minutes: 10/);
  assert.match(workflow, /CLOUDFLARE_BUILD_TIMEOUT_MINUTES: "5"/);
  assert.match(workflow, /needs\.select-workers\.outputs\.topology_rename == 'true'/);
  assert.match(workflow, /run: node \.github\/scripts\/cloudflare-build-diagnostics\.mjs/);
  assert.doesNotMatch(workflow, /if \[\[ "\$status" -eq 4 \]\]/);
  assert.doesNotMatch(workflow, /direct PR deploy already succeeded/);
  assert.doesNotMatch(workflow, /exit "\$status"/);
});
