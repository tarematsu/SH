import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  cloudflareBuildConfig,
  selectCloudflareBuildConfig,
} from '../scripts/select-cloudflare-build-config.mjs';

test('current Worker names map to their Wrangler configs', () => {
  assert.equal(cloudflareBuildConfig('sh-buddies-monitor'), null);
  assert.equal(cloudflareBuildConfig('sh-buddies-persist'), 'wrangler.persist.jsonc');
  assert.equal(cloudflareBuildConfig('sh-buddies-ingest'), 'wrangler.ingest.jsonc');
  assert.equal(cloudflareBuildConfig('sh-buddies-comments'), 'wrangler.comments.jsonc');
  assert.equal(cloudflareBuildConfig('sh-minute-read-model'), null);
  assert.equal(cloudflareBuildConfig('sh-track-metadata'), 'wrangler.track-metadata.jsonc');
  assert.equal(cloudflareBuildConfig('sh-pages-read-model'), 'wrangler.pages-read-model.jsonc');
  assert.equal(cloudflareBuildConfig('sh-monitor-maintenance'), null);
  assert.equal(cloudflareBuildConfig('sh-monitor-other'), 'wrangler.other.jsonc');
  assert.equal(cloudflareBuildConfig('sh-buddy-playback'), null);
  assert.equal(cloudflareBuildConfig('sh-minute-maintenance'), null);
  assert.equal(cloudflareBuildConfig('sh-minute-derive'), 'wrangler.minute-derive.jsonc');
  assert.equal(cloudflareBuildConfig('sh-minute-enrichment'), 'wrangler.minute-enrichment.jsonc');
  assert.equal(cloudflareBuildConfig('sh-minute-rebuild'), 'wrangler.minute-rebuild.jsonc');
  assert.equal(cloudflareBuildConfig('sh-minute-ingest'), 'wrangler.minute-ingest.jsonc');
  assert.equal(cloudflareBuildConfig('unknown-worker'), null);
  assert.equal(cloudflareBuildConfig(''), null);
});

test('connected build replaces only the ephemeral default config', async () => {
  const workerRoot = await mkdtemp(join(tmpdir(), 'sh-worker-config-'));
  try {
    await writeFile(join(workerRoot, 'wrangler.jsonc'), '{"name":"sh-buddies-monitor"}\n');
    await writeFile(join(workerRoot, 'wrangler.other.jsonc'), '{"name":"sh-monitor-other"}\n');

    const result = await selectCloudflareBuildConfig({
      workerName: 'sh-monitor-other',
      workerRoot,
    });

    assert.deepEqual(result, {
      selected: true,
      workerName: 'sh-monitor-other',
      sourceName: 'wrangler.other.jsonc',
    });
    assert.equal(
      await readFile(join(workerRoot, 'wrangler.jsonc'), 'utf8'),
      '{"name":"sh-monitor-other"}\n',
    );
  } finally {
    await rm(workerRoot, { recursive: true, force: true });
  }
});

test('local installs and unknown build names leave the tracked default config untouched', async () => {
  assert.deepEqual(
    await selectCloudflareBuildConfig({ workerName: '' }),
    { selected: false, workerName: null, sourceName: null },
  );
  assert.deepEqual(
    await selectCloudflareBuildConfig({ workerName: 'unknown-worker' }),
    { selected: false, workerName: 'unknown-worker', sourceName: null },
  );
});
