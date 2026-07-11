import assert from 'node:assert/strict';
import test from 'node:test';

import { validatedStreamCount } from '../functions/lib/d1-lean-ingest.js';

test('uses current_stream_count even when total_listens disagrees', () => {
  const current = {
    last_stream_count: 1000000,
    last_stream_at: 1000000,
    last_snapshot_at: 1000000,
  };
  const value = validatedStreamCount({
    current_stream_count: 1000120,
    total_listens: 340,
  }, current, 1060000);
  assert.equal(value, 1000120);
});

test('rejects an extreme current_stream_count without consulting total_listens', () => {
  const current = {
    last_stream_count: 1000000,
    last_stream_at: 1000000,
    last_snapshot_at: 1000000,
  };
  const value = validatedStreamCount({
    current_stream_count: 280,
    total_listens: 1000120,
  }, current, 1060000);
  assert.equal(value, null);
});

test('uses current_stream_count when no baseline exists', () => {
  const value = validatedStreamCount({
    current_stream_count: 320,
    total_listens: 950000,
  }, {}, 1060000);
  assert.equal(value, 320);
});

test('does not treat total_listens alone as a stream count', () => {
  const value = validatedStreamCount({ total_listens: 950000 }, {}, 1060000);
  assert.equal(value, null);
});

test('uses the last accepted stream time after rejected snapshots', () => {
  const current = {
    last_stream_count: 1000000,
    last_stream_at: 1000000,
    last_snapshot_at: 1540000,
  };
  const value = validatedStreamCount({ current_stream_count: 1060000 }, current, 1600000);
  assert.equal(value, 1060000);
});
