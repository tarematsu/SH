import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeComments } from '../worker/src/shared.js';
import { commentsToWrite } from '../site/functions/api/ingest.js';
import { hostCommentsToWrite } from '../site/functions/api/host-ingest.js';

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

test('normal comment storage writes each numeric ID at most once', () => {
  const changed = commentsToWrite([
    { id: 101, raw: { id: 101, text: 'old' } },
    { id: 101, raw: { id: 101, text: 'new' } },
    { id: 102, raw: { id: 102, text: 'second' } },
  ], []);

  assert.deepEqual(changed.map((comment) => comment.id), [101, 102]);
  assert.equal(changed[0].raw.text, 'new');
});

test('solo comment storage deduplicates within each broadcast session', () => {
  const changed = hostCommentsToWrite([
    { comment_id: 501, raw: { id: 501, text: 'old' } },
    { comment_id: 501, raw: { id: 501, text: 'new' } },
    { comment_id: 502, raw: { id: 502, text: 'second' } },
  ], []);

  assert.deepEqual(changed.map((comment) => comment.comment_id), [501, 502]);
  assert.equal(changed[0].raw.text, 'new');
});

test('already stored identical comments are skipped', () => {
  const raw = JSON.stringify({ id: 101, text: 'same' });
  const normal = commentsToWrite([
    { id: 101, raw: { id: 101, text: 'same' } },
  ], [{ id: 101, raw_json: raw }]);
  const solo = hostCommentsToWrite([
    { comment_id: 101, raw: { id: 101, text: 'same' } },
  ], [{ comment_id: 101, raw_json: raw }]);

  assert.deepEqual(normal, []);
  assert.deepEqual(solo, []);
});
