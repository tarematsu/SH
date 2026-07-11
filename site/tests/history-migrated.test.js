import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeMinuteFactsCursor,
  minuteFactsRowsSql,
  minuteFactsStatsSql,
  migrationStateSql,
} from '../functions/api/history-migrated.js';

test('history confirmation reads Stationhead-DB minute facts and normalized catalogs', () => {
  const sql = minuteFactsRowsSql();
  assert.match(sql, /FROM sh_minute_facts f/);
  assert.match(sql, /LEFT JOIN sh_tracks/);
  assert.match(sql, /LEFT JOIN sh_hosts/);
  assert.match(sql, /LEFT JOIN sh_broadcast_sessions/);
  assert.match(sql, /LEFT JOIN sh_queue_revisions/);
  assert.doesNotMatch(sql, /sh_legacy_samples/);
  assert.doesNotMatch(sql, /sh_legacy_snapshots/);
});

test('history separates cumulative listeners from reported stream counts', () => {
  const sql = minuteFactsRowsSql();
  assert.match(sql, /CASE WHEN f\.source='live_collector' THEN f\.reported_total_listens ELSE NULL END/);
  assert.match(sql, /AS cumulative_listener_count/);
  assert.match(sql, /CASE WHEN f\.source='live_collector' THEN f\.reported_current_stream_count/);
  assert.match(sql, /COALESCE\(f\.reported_current_stream_count,f\.reported_total_listens\)/);
  assert.match(sql, /AS reported_stream_count/);
});

test('minute facts history adds source, host, track and cursor filters', () => {
  const sql = minuteFactsRowsSql({ source: true, host: true, track: true, cursor: true });
  assert.match(sql, /f\.source=\?/);
  assert.match(sql, /lower\(COALESCE\(h\.current_handle,''\)\) LIKE \?/);
  assert.match(sql, /lower\(COALESCE\(t\.title,''\)\) LIKE \?/);
  assert.match(sql, /lower\(COALESCE\(t\.isrc,''\)\) LIKE \?/);
  assert.match(sql, /f\.minute_at>\? OR \(f\.minute_at=\? AND f\.id>\?\)/);
  assert.match(sql, /ORDER BY f\.minute_at ASC,f\.id ASC LIMIT \?$/);
});

test('minute facts stats report live and both legacy sources', () => {
  const sql = minuteFactsStatsSql();
  assert.match(sql, /source='live_collector'/);
  assert.match(sql, /source='legacy_normalized'/);
  assert.match(sql, /source='legacy_raw'/);
  assert.match(sql, /COUNT\(\*\) FROM sh_tracks/);
  assert.match(sql, /COUNT\(\*\) FROM sh_broadcast_sessions/);
  assert.match(sql, /sh_queue_revisions WHERE status='complete'/);
});

test('migration status uses the minute facts migration state', () => {
  const sql = migrationStateSql();
  assert.match(sql, /FROM sh_migration_state/);
  assert.match(sql, /legacy-minute-facts-v1/);
  assert.match(sql, /cursor_observed_at/);
  assert.match(sql, /error_rows/);
});

test('minute facts cursor rejects malformed values', () => {
  assert.deepEqual(decodeMinuteFactsCursor(Buffer.from('123:45').toString('base64')), { timestamp: 123, id: 45 });
  assert.equal(decodeMinuteFactsCursor('not-base64***'), null);
  assert.equal(decodeMinuteFactsCursor(Buffer.from('-1:45').toString('base64')), null);
  assert.equal(decodeMinuteFactsCursor(Buffer.from('123').toString('base64')), null);
});
