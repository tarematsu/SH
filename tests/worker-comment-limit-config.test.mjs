import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const commentsConfig = JSON.parse(await readFile(new URL('../worker/wrangler.comments.jsonc', import.meta.url), 'utf8'));
const otherConfig = JSON.parse(await readFile(new URL('../worker/wrangler.other.jsonc', import.meta.url), 'utf8'));

test('normal and solo comment collection are configured for 50 items', () => {
  assert.equal(commentsConfig.vars.CHAT_LIMIT, 50);
  assert.equal(otherConfig.vars.SOLO_CHAT_LIMIT, 50);
});
