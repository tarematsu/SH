import assert from 'node:assert/strict';
import test from 'node:test';

import { reportedStreamCount } from '../functions/lib/d1-lean-ingest.js';

test('uses Stationhead current_stream_count as the total stream count', () => {
  assert.equal(reportedStreamCount({ current_stream_count: 1_234_567 }), 1_234_567);
  assert.equal(reportedStreamCount({ current_stream_count: 0 }), 0);
});

test('never substitutes total_listens for the total stream count', () => {
  assert.equal(reportedStreamCount({ total_listens: 950_000 }), null);
  assert.equal(reportedStreamCount({ current_stream_count: null, total_listens: 950_000 }), null);
});

test('rejects only structurally invalid reported stream values', () => {
  assert.equal(reportedStreamCount({ current_stream_count: -1 }), null);
  assert.equal(reportedStreamCount({ current_stream_count: 'not-a-number' }), null);
});
