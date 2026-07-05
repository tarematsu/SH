import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RECONCILE_SUPERSEDED_ANNOUNCEMENTS_SQL,
  reconcileSupersededAnnouncements
} from '../src/official-news-reconcile.js';
import { runScheduledWithOfficialReconciliation } from '../src/official-news-reconcile-entry.js';

test('reconciliation only supersedes older pending schedules for the same article', async () => {
  const calls = [];
  const env = {
    DB: {
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
    DB: {
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

test('scheduled reconciliation waits for official news but not unrelated background work', async () => {
  const order = [];
  const held = [];
  let releaseNews;
  let releaseUnrelated;
  const newsTask = new Promise((resolve) => {
    releaseNews = () => {
      order.push('news-finished');
      resolve();
    };
  });
  const unrelatedTask = new Promise((resolve) => {
    releaseUnrelated = () => {
      order.push('unrelated-finished');
      resolve();
    };
  });
  const ctx = {
    waitUntil(task) {
      held.push(Promise.resolve(task));
    }
  };
  const scheduled = async (_controller, _env, wrappedCtx) => {
    wrappedCtx.waitUntil(newsTask);
    wrappedCtx.waitUntil(unrelatedTask);
    order.push('scheduled-returned');
    return 'primary-complete';
  };
  const reconcile = async (_env, runStartedAt) => {
    assert.ok(Number.isFinite(runStartedAt));
    order.push('reconciled');
    return { changes: 1, skipped: false };
  };

  const result = await runScheduledWithOfficialReconciliation(
    { cron: '* * * * *' },
    {},
    ctx,
    scheduled,
    reconcile
  );
  assert.equal(result, 'primary-complete');
  assert.deepEqual(order, ['scheduled-returned']);
  assert.equal(held.length, 3);

  releaseNews();
  await held[2];
  assert.deepEqual(order, ['scheduled-returned', 'news-finished', 'reconciled']);

  releaseUnrelated();
  await held[1];
  assert.deepEqual(order, [
    'scheduled-returned',
    'news-finished',
    'reconciled',
    'unrelated-finished'
  ]);
});

test('rejected official news tasks do not reconcile schedules', async () => {
  const held = [];
  let reconciliations = 0;
  const ctx = {
    waitUntil(task) {
      held.push(Promise.resolve(task).catch(() => {}));
    }
  };
  const result = await runScheduledWithOfficialReconciliation(
    { cron: '* * * * *' },
    {},
    ctx,
    async (_controller, _env, wrappedCtx) => {
      wrappedCtx.waitUntil(Promise.reject(new Error('news failed unexpectedly')));
      return 'primary-complete';
    },
    async () => {
      reconciliations += 1;
    }
  );
  assert.equal(result, 'primary-complete');
  await Promise.all(held);
  assert.equal(reconciliations, 0);
});

test('missing official news tasks avoid an unnecessary D1 reconciliation', async () => {
  let reconciliations = 0;
  const result = await runScheduledWithOfficialReconciliation(
    { cron: '* * * * *' },
    {},
    { waitUntil() {} },
    async () => 'primary-complete',
    async () => {
      reconciliations += 1;
    }
  );
  assert.equal(result, 'primary-complete');
  assert.equal(reconciliations, 0);
});
