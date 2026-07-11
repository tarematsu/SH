import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const scriptUrl = new URL('../public/history/history-track-recovery-cache.js', import.meta.url);

async function runScript() {
  const source = await readFile(scriptUrl, 'utf8');
  const reads = [];
  const writes = [];
  const fetches = [];
  const context = {
    URL,
    readCache(key) {
      reads.push(key);
      return key.includes(':v17:') ? { restored: true } : { stale: true };
    },
    writeCache(key, value) {
      writes.push([key, value]);
    },
    window: {
      location: new URL('https://example.test/history/'),
      async fetch(input) {
        fetches.push(String(input));
        return { ok: true };
      },
    },
  };
  vm.runInNewContext(source, context);
  return { context, reads, writes, fetches };
}

test('track recovery cache ignores every older local cache generation', async () => {
  const { context, reads, writes } = await runScript();

  for (const version of [11, 12, 13, 14, 15, 16]) {
    const key = `track-history:v${version}:2026-06-30:2026-06-30`;
    const value = context.readCache(key);
    context.writeCache(key, { rows: [] });
    assert.deepEqual(value, { restored: true });
  }

  assert.ok(reads.every((key) => key === 'track-history:v17:2026-06-30:2026-06-30'));
  assert.ok(writes.every(([key]) => key === 'track-history:v17:2026-06-30:2026-06-30'));
});

test('track recovery fetch adds a distinct server cache version', async () => {
  const { context, fetches } = await runScript();

  await context.window.fetch('/api/track-history?from=2026-06-30&to=2026-06-30');

  const url = new URL(fetches[0]);
  assert.equal(url.pathname, '/api/track-history');
  assert.equal(url.searchParams.get('recovery'), '5');
});
