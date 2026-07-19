import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const commentsConfig = JSON.parse(await readFile(new URL('../worker/wrangler.comments.jsonc', import.meta.url), 'utf8'));
const otherConfig = JSON.parse(await readFile(new URL('../worker/wrangler.other.jsonc', import.meta.url), 'utf8'));

test('normal comment collection is bounded below solo collection', () => {
  assert.equal(commentsConfig.vars.CHAT_LIMIT, 40);
  assert.equal(otherConfig.vars.SOLO_CHAT_LIMIT, 50);
});
