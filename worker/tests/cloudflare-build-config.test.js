import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ACTIVE_WORKER_BUILDS,
  cloudflareBuildConfig,
} from '../scripts/cloudflare-build-config.mjs';

test('only active Worker names map to static Wrangler configs', () => {
  assert.deepEqual(ACTIVE_WORKER_BUILDS, {
    'sh-buddies-ingest': 'wrangler.ingest.jsonc',
    'sh-minute-enrichment': 'wrangler.minute-enrichment.jsonc',
    'sh-runtime-orchestrator': 'wrangler.runtime.jsonc',
  });

  assert.equal(cloudflareBuildConfig('sh-buddies-ingest'), 'wrangler.ingest.jsonc');
  assert.equal(cloudflareBuildConfig('sh-minute-enrichment'), 'wrangler.minute-enrichment.jsonc');
  assert.equal(cloudflareBuildConfig('sh-runtime-orchestrator'), 'wrangler.runtime.jsonc');

  for (const retired of [
    'sh-monitor-other',
    'sh-buddies-persist',
    'sh-buddies-comments',
    'sh-minute-derive',
    'sh-minute-rebuild',
    'sh-minute-ingest',
    'sh-track-metadata',
    'sh-pages-read-model',
  ]) {
    assert.equal(cloudflareBuildConfig(retired), null);
  }
  assert.equal(cloudflareBuildConfig('unknown-worker'), null);
  assert.equal(cloudflareBuildConfig(''), null);
});
