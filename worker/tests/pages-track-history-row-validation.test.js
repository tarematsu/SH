import assert from 'node:assert/strict';
import test from 'node:test';

import { splitTrackHistoryPublicationRows } from '../src/pages-track-history-response.js';

test('D1 validation markers preserve durable row JSON without reparsing it in JavaScript', () => {
  const chunks = splitTrackHistoryPublicationRows([
    { row_json: '{"id":1,"title":"Song"}', row_json_valid: 1 },
  ]);
  assert.deepEqual(chunks, ['{"id":1,"title":"Song"}']);
});

test('invalid D1 markers and unmarked invalid dependency rows are rejected', () => {
  assert.throws(
    () => splitTrackHistoryPublicationRows([{ row_json: '{', row_json_valid: 0 }]),
    /invalid JSON/,
  );
  assert.throws(
    () => splitTrackHistoryPublicationRows([{ row_json: '{' }]),
    SyntaxError,
  );
});
