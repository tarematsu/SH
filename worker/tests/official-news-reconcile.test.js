import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RECONCILE_SUPERSEDED_ANNOUNCEMENTS_SQL,
  reconcileSupersededAnnouncements
} from '../src/official-news-reconcile.js';

test('reconciliation only supersedes older pending schedules for the same article', async () => {
  const calls = [];
  const env = {
    OTHER_DB: {
      prepare(sql) {
        calls.push({ kind: 'prepare', sql });
        return {
          bind(...values) {
            calls.push({ kind: 'bind', values });
            return this;
          },
          async run() {
            calls.push({ kind: 'run' });
            return { meta: { changes: 2 } };
          }
        };
      }
    }
  };

  const result = await reconcileSupersededAnnouncements(env, 12345, 23456);

  assert.deepEqual(result, { changes: 2, skipped: false });
  assert.equal(calls[0].sql, RECONCILE_SUPERSEDED_ANNOUNCEMENTS_SQL);
  assert.match(calls[0].sql, /stale\.status='scheduled'/);
  assert.match(calls[0].sql, /monitor\.last_success_at=monitor\.last_check_at/);
  assert.match(calls[0].sql, /monitor\.last_check_at>=\?/);
  assert.match(calls[0].sql, /current\.news_id=stale\.news_id/);
  assert.match(calls[0].sql, /current\.status<>'superseded'/);
  assert.match(calls[0].sql, /current\.updated_at>stale\.updated_at/);
  assert.doesNotMatch(calls[0].sql, /current\.scheduled_at IS NOT NULL/);
  assert.deepEqual(calls[1].values, [23456, 12345]);
});

test('missing optional announcement tables skip reconciliation', async () => {
  const env = {
    OTHER_DB: {
      prepare() {
        return {
          bind() {
            return this;
          },
          async run() {
            throw new Error('no such table: sh_official_news_announcements');
          }
        };
      }
    }
  };

  assert.deepEqual(
    await reconcileSupersededAnnouncements(env),
    { changes: 0, skipped: true }
  );
});
