import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

import { normalizeComments } from '../worker/src/shared.js';

const ingestSource = readFileSync(
  new URL('../site/functions/lib/ingest.js', import.meta.url),
  'utf8',
);

 test('normal comment payloads drop duplicate upstream IDs', () => {
  const normalized = normalizeComments({
    chats: {
      items: [
        { id: 101, text: 'first', account: { id: 1, handle: 'a' } },
        { id: 101, text: 'duplicate', account: { id: 1, handle: 'a' } },
        { id: 102, text: 'second', account: { id: 2, handle: 'b' } },
      ],
    },
  }, 55);

  assert.deepEqual(normalized.map((comment) => comment.id), [101, 102]);
});

test('comment ingest persists aggregate counts without a raw comment writer', () => {
  assert.match(ingestSource, /saveCommentCounts/);
  assert.doesNotMatch(ingestSource, /sh_comments|text_with_xml|commentWriteStatements/);
  assert.equal(existsSync(new URL('../site/functions/lib/ingest-legacy.mjs', import.meta.url)), false);
  assert.equal(existsSync(new URL('../site/functions/lib/ingest-core.js', import.meta.url)), false);
});
