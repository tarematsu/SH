import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(
  new URL('../.github/workflows/fetch-cloudflare-observability.yml', import.meta.url),
  'utf8',
);

test('deployed telemetry audit changes trigger a fresh observability run', () => {
  assert.match(
    workflow,
    /^\s{6}- '\.github\/scripts\/audit-deployed-cloudflare-telemetry\.py'$/m,
  );
});
