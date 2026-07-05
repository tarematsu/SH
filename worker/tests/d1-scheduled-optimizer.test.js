import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EMPTY_CLEANUP_BACKOFF_MS,
  OFFICIAL_NEWS_CLAIM_SQL,
  scheduledStatementKind
} from '../src/d1-scheduled-optimizer.js';

test('official news state read is replaced by an atomic conditional claim', () => {
  assert.equal(
    scheduledStatementKind(`SELECT last_check_at,last_success_at,last_error
      FROM sh_official_news_monitor_state WHERE id=?`),
    'official-news-state-read'
  );
  assert.match(OFFICIAL_NEWS_CLAIM_SQL, /ON CONFLICT\(id\) DO UPDATE/i);
  assert.match(OFFICIAL_NEWS_CLAIM_SQL, /WHERE COALESCE\(.+last_check_at,0\)<=\?/is);
  assert.match(OFFICIAL_NEWS_CLAIM_SQL, /RETURNING last_success_at,last_error/i);
});

test('retention cleanup statements and final state write are classified', () => {
  assert.equal(
    scheduledStatementKind(`DELETE FROM sh_channel_snapshots WHERE id IN (
      SELECT id FROM sh_channel_snapshots WHERE observed_at<? LIMIT ?
    )`),
    'retention-cleanup'
  );
  assert.equal(
    scheduledStatementKind(`INSERT INTO sh_data_maintenance_state(
      id,last_rollup_key,last_cleanup_at,legacy_backfill_id,updated_at
    ) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      last_rollup_key=CASE WHEN 1 THEN excluded.last_rollup_key END`),
    'maintenance-final-state'
  );
  assert.equal(EMPTY_CLEANUP_BACKOFF_MS, 6 * 60 * 60_000);
});
