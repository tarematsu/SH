import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeFactRow,
  decodeMinuteFactsCursor,
  minuteFactsRowsSql,
  minuteFactsStatsSql,
  migrationStateSql,
} from '../functions/api/minute-facts/index.js';

test('minute facts history reads the normalized facts and catalogs', () => {
  const sql = minuteFactsRowsSql();
  assert.match(sql, /FROM sh_minute_facts f/);
  assert.match(sql, /LEFT JOIN sh_tracks/);
  assert.match(sql, /LEFT JOIN sh_hosts/);
  assert.match(sql, /LEFT JOIN sh_minute_fact_context/);
  assert.match(sql, /LEFT JOIN sh_minute_fact_collectors/);
  assert.match(sql, /LEFT JOIN sh_broadcast_sessions/);
  assert.match(sql, /LEFT JOIN sh_queue_revisions/);
  assert.doesNotMatch(sql, /sh_legacy_samples/);
  assert.doesNotMatch(sql, /sh_legacy_snapshots/);
});

test('minute facts separates cumulative listeners from Stationhead total streams', () => {
  const sql = minuteFactsRowsSql();
  assert.match(sql, /CASE WHEN f\.source_code=1 THEN f\.reported_total_listens ELSE NULL END/);
  assert.match(sql, /AS cumulative_listener_count/);
  assert.match(sql, /CASE WHEN f\.source_code=1 THEN f\.reported_current_stream_count/);
  assert.match(sql, /COALESCE\(f\.reported_current_stream_count,f\.reported_total_listens\)/);
  assert.match(sql, /AS total_stream_count/);
  assert.doesNotMatch(sql, /f\.validated_stream_count/);
  assert.match(sql, /f\.track_confidence_code\/100\.0 AS track_confidence/);
  assert.match(sql, /f\.quality_score_code\/100\.0 AS quality_score/);
});

test('minute facts history adds source, host, track and cursor filters', () => {
  const sql = minuteFactsRowsSql({ source: true, host: true, track: true, cursor: true });
  assert.match(sql, /f\.source_code=\?/);
  assert.match(sql, /lower\(COALESCE\(h\.current_handle,''\)\) LIKE \?/);
  assert.match(sql, /lower\(COALESCE\(t\.title,''\)\) LIKE \?/);
  assert.match(sql, /lower\(COALESCE\(t\.isrc,''\)\) LIKE \?/);
  assert.match(sql, /f\.minute_at>\? OR \(f\.minute_at=\? AND f\.id>\?\)/);
  assert.match(sql, /ORDER BY f\.minute_at ASC,f\.id ASC LIMIT \?$/);
});

test('current minute facts query reads exactly the newest rows for the current tab', () => {
  const sql = minuteFactsRowsSql({ latest: true });
  assert.doesNotMatch(sql, /WHERE f\.minute_at>=\?/);
  assert.match(sql, /ORDER BY f\.minute_at DESC,f\.id DESC LIMIT \?$/);
});

test('minute facts stats report live and both legacy sources', () => {
  const sql = minuteFactsStatsSql();
  assert.match(sql, /source_code=1/);
  assert.match(sql, /source_code=2/);
  assert.match(sql, /source_code=3/);
  assert.match(sql, /source_code=4/);
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

test('fact rows decode dictionary-coded source and track detection method back to strings', () => {
  assert.deepEqual(decodeFactRow({
    id: 1, minute_at: 60_000, source_code: 1, track_detection_code: 1,
  }), {
    id: 1, minute_at: 60_000, source: 'live_collector', track_detection_method: 'queue_inferred',
  });
  assert.deepEqual(decodeFactRow({
    id: 2, minute_at: 120_000, source_code: 2, track_detection_code: 0,
  }), {
    id: 2, minute_at: 120_000, source: 'live_reconstructed', track_detection_method: 'unknown',
  });
});

test('minute facts cursor rejects malformed values', () => {
  assert.deepEqual(decodeMinuteFactsCursor(Buffer.from('123:45').toString('base64')), { timestamp: 123, id: 45 });
  assert.equal(decodeMinuteFactsCursor('not-base64***'), null);
  assert.equal(decodeMinuteFactsCursor(Buffer.from('-1:45').toString('base64')), null);
  assert.equal(decodeMinuteFactsCursor(Buffer.from('123').toString('base64')), null);
});
