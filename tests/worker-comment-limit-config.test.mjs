import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const ingestConfig = JSON.parse(await readFile(
  new URL('../worker/wrangler.ingest.jsonc', import.meta.url),
  'utf8',
));
const sakurazakaConfig = JSON.parse(await readFile(
  new URL('../worker/wrangler.sakurazaka46jp.jsonc', import.meta.url),
  'utf8',
));

test('normal comment collection remains disabled below compact solo collection', () => {
  assert.equal(ingestConfig.vars.CHAT_LIMIT, 0);
  assert.equal(sakurazakaConfig.vars.SOLO_CHAT_LIMIT, 50);
});
