import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(
  new URL('../.github/workflows/cloudflare-pr-diagnostics.yml', import.meta.url),
  'utf8',
);

test('Cloudflare PR diagnostics do not block on an absent connected build', () => {
  assert.match(workflow, /timeout-minutes: 10/);
  assert.match(workflow, /CLOUDFLARE_BUILD_TIMEOUT_MINUTES: "5"/);
  assert.match(workflow, /if \[\[ "\$status" -eq 4 \]\]/);
  assert.match(workflow, /direct PR deploy already succeeded/);
  assert.match(workflow, /exit "\$status"/);
});
