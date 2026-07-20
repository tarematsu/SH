import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const ACTIVE_CONFIGS = [
  'worker/wrangler.ingest.jsonc',
  'worker/wrangler.minute-enrichment.jsonc',
  'worker/wrangler.runtime.jsonc',
];

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

test('agent instructions pin repository and active Cloudflare topology', async () => {
  const instructions = await source('AGENTS.md');
  assert.match(instructions, /`tarematsu\/SH`/);
  assert.match(instructions, /older chats/);
  assert.match(instructions, /existing browser tab/);

  for (const path of ACTIVE_CONFIGS) {
    assert.match(instructions, new RegExp(path.replaceAll('.', '\\.')));
  }

  const configs = await Promise.all(ACTIVE_CONFIGS.map(source));
  const workerNames = configs.map((config) => JSON.parse(config).name);
  assert.deepEqual(workerNames, [
    'sh-buddies-ingest',
    'sh-minute-enrichment',
    'sh-runtime-orchestrator',
  ]);

  const databaseNames = new Set(configs.flatMap((config) => (
    JSON.parse(config).d1_databases.map(({ database_name: name }) => name)
  )));
  assert.deepEqual([...databaseNames].sort(), [
    'stationhead-buddies',
    'stationhead-minute',
    'stationhead-other',
  ]);
});

test('metrics instructions require provenance and reject foreign resources', async () => {
  const instructions = await source('AGENTS.md');
  assert.match(instructions, /actual, estimated, extrapolated, or unavailable/);
  assert.match(instructions, /measurement window and timestamp/);
  assert.match(instructions, /absent from the active configurations as foreign/);
  assert.match(instructions, /Never display tokens/);
  assert.match(instructions, /fresh or repository-dedicated browser conversation/);
});
