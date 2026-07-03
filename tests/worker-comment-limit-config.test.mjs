import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const config = JSON.parse(await readFile(new URL('../worker/wrangler.jsonc', import.meta.url), 'utf8'));

test('normal and solo comment collection are configured for 50 items', () => {
  assert.equal(config.vars.CHAT_LIMIT, 50);
  assert.equal(config.vars.SOLO_CHAT_LIMIT, 50);
});
