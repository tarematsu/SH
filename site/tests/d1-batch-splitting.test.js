import assert from 'node:assert/strict';
import test from 'node:test';

import {
  D1_BATCH_STATEMENT_LIMIT,
  D1_BATCH_VARIABLE_LIMIT,
  splitD1Batches,
} from '../functions/lib/d1-optimized-ingest.js';

function statement(bindCount) {
  return { params: Array.from({ length: bindCount }, (_, index) => index) };
}

test('D1 queue write batches stay below the bind variable safety limit', () => {
  const queueItemStatements = Array.from({ length: 71 }, () => statement(15));
  const likeCurrentStatements = Array.from({ length: 71 }, () => statement(12));
  const likeObservationStatements = Array.from({ length: 71 }, () => statement(14));
  const groups = splitD1Batches([
    statement(6),
    statement(73),
    statement(72),
    ...queueItemStatements,
    ...likeCurrentStatements,
    ...likeObservationStatements,
    statement(8),
  ]);

  assert.ok(groups.length > 1, 'long queue writes must be split across multiple D1 batches');
  for (const group of groups) {
    assert.ok(group.length <= D1_BATCH_STATEMENT_LIMIT);
    const bindCount = group.reduce((sum, item) => sum + item.params.length, 0);
    assert.ok(
      bindCount <= D1_BATCH_VARIABLE_LIMIT,
      `batch has ${bindCount} bind variables, above ${D1_BATCH_VARIABLE_LIMIT}`,
    );
  }
});
