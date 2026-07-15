import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeRecoveredStreamCounts,
  rawHistorySql,
  recoveredStreamSql,
} from '../functions/api/history-raw.js';

test('raw history never substitutes cumulative listeners for total streams', () => {
  const sql = rawHistorySql(false);
  assert.match(sql, /f\.reported_current_stream_count AS total_stream_count/);
  assert.doesNotMatch(sql, /COALESCE\(f\.reported_current_stream_count,f\.reported_total_listens\)/);
});

test('stream recovery uses preserved Stationhead fields and rejects listener-equal fallback', () => {
  const sql = recoveredStreamSql();
  assert.match(sql, /\$\.current_stream_count/);
  assert.match(sql, /\$\.current_station\.streaming_party\.current_stream_count/);
  assert.match(sql, /current_stream_count IS NOT total_listens/);
});

test('missing legacy total streams are recovered by channel and minute without overwriting direct values', () => {
  const rows = [
    { id: 1, channel_id: 10, minute_at: 60_000, total_stream_count: null },
    { id: 2, channel_id: 10, minute_at: 120_000, total_stream_count: 999 },
    { id: 3, channel_id: 20, minute_at: 60_000, total_stream_count: null },
  ];
  const snapshots = [
    { id: 4, channel_id: 10, minute_at: 60_000, observed_at: 61_000, total_stream_count: 100 },
    { id: 5, channel_id: 10, minute_at: 60_000, observed_at: 62_000, total_stream_count: 101 },
    { id: 6, channel_id: 10, minute_at: 120_000, observed_at: 121_000, total_stream_count: 200 },
    { id: 7, channel_id: 20, minute_at: 60_000, observed_at: 63_000, total_stream_count: null },
  ];

  assert.deepEqual(mergeRecoveredStreamCounts(rows, snapshots), {
    rows: [
      { id: 1, channel_id: 10, minute_at: 60_000, total_stream_count: 101 },
      { id: 2, channel_id: 10, minute_at: 120_000, total_stream_count: 999 },
      { id: 3, channel_id: 20, minute_at: 60_000, total_stream_count: null },
    ],
    recoveredCount: 1,
  });
});
