import test from 'node:test';
import assert from 'node:assert/strict';
import {
  countIncompleteStreamCounts,
  rawHistorySql,
} from '../functions/api/history-raw.js';

test('raw history never substitutes cumulative listeners for total streams', () => {
  const sql = rawHistorySql(false);
  assert.match(sql, /f\.reported_current_stream_count AS total_stream_count/);
  assert.doesNotMatch(sql, /COALESCE\(f\.reported_current_stream_count,f\.reported_total_listens\)/);
});

test('raw history does not query collector snapshots', () => {
  const sql = rawHistorySql(false);
  assert.doesNotMatch(sql, /sh_channel_snapshots/);
  assert.doesNotMatch(sql, /raw_json/);
});

test('raw history reports incomplete stream values without fabricating them', () => {
  assert.equal(countIncompleteStreamCounts([
    { total_stream_count: null },
    { total_stream_count: '' },
    { total_stream_count: -1 },
    { total_stream_count: 0 },
    { total_stream_count: 10 },
  ]), 3);
});
