import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  cloudflareBuildConfig,
  selectCloudflareBuildConfig,
} from '../scripts/select-cloudflare-build-config.mjs';

test('connected Worker names map to their Wrangler configs', () => {
  assert.equal(cloudflareBuildConfig('sh-monitor-buddies'), 'wrangler.jsonc');
  assert.equal(cloudflareBuildConfig('sh-monitor-other'), 'wrangler.other.jsonc');
  assert.equal(cloudflareBuildConfig('sh-monitor-minute'), 'wrangler.minute.jsonc');
  assert.equal(cloudflareBuildConfig('unknown-worker'), null);
});

test('minute connected build replaces only the ephemeral default config', async () => {
  const workerRoot = await mkdtemp(join(tmpdir(), 'sh-worker-config-'));
  try {
    await writeFile(join(workerRoot, 'wrangler.jsonc'), '{"name":"sh-monitor-buddies"}\n');
    await writeFile(join(workerRoot, 'wrangler.minute.jsonc'), '{"name":"sh-monitor-minute"}\n');

    const result = await selectCloudflareBuildConfig({
      workerName: 'sh-monitor-minute',
      workerRoot,
    });

    assert.deepEqual(result, {
      selected: true,
      workerName: 'sh-monitor-minute',
      sourceName: 'wrangler.minute.jsonc',
    });
    assert.equal(
      await readFile(join(workerRoot, 'wrangler.jsonc'), 'utf8'),
      '{"name":"sh-monitor-minute"}\n',
    );
  } finally {
    await rm(workerRoot, { recursive: true, force: true });
  }
});

test('local installs leave the tracked default config untouched', async () => {
  const result = await selectCloudflareBuildConfig({ workerName: '' });
  assert.deepEqual(result, { selected: false, workerName: null, sourceName: null });
});
