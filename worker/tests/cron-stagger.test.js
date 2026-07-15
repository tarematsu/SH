import assert from 'node:assert/strict';
import test from 'node:test';

import { applyCronStagger, cronStaggerDelayMs, cronStaggerEnabled, waitForCollectorCompletion } from '../src/cron-stagger.js';

test('cronStaggerEnabled defaults to true and honors explicit disable', () => {
  assert.equal(cronStaggerEnabled({}), true);
  assert.equal(cronStaggerEnabled({ CRON_STAGGER_ENABLED: 'false' }), false);
  assert.equal(cronStaggerEnabled({ CRON_STAGGER_ENABLED: 'true' }), true);
});

test('cronStaggerDelayMs uses per-worker defaults and env overrides', () => {
  assert.equal(cronStaggerDelayMs({}, 'other'), 25_000);
  assert.equal(cronStaggerDelayMs({}, 'minute'), 12_000);
  assert.equal(cronStaggerDelayMs({}, 'buddies'), 0);
  assert.equal(cronStaggerDelayMs({ CRON_STAGGER_OTHER_MS: 5_000 }, 'other'), 5_000);
});

test('cronStaggerDelayMs clamps overrides to a sane maximum', () => {
  assert.equal(cronStaggerDelayMs({ CRON_STAGGER_MINUTE_MS: 999_999 }, 'minute'), 45_000);
  assert.equal(cronStaggerDelayMs({ CRON_STAGGER_MINUTE_MS: -5 }, 'minute'), 12_000);
});

test('applyCronStagger sleeps for the configured delay using the injected sleep function', async () => {
  const waits = [];
  const delay = await applyCronStagger({}, 'other', async (ms) => { waits.push(ms); });
  assert.equal(delay, 25_000);
  assert.deepEqual(waits, [25_000]);
});

test('applyCronStagger does not sleep when disabled', async () => {
  const waits = [];
  const delay = await applyCronStagger({ CRON_STAGGER_ENABLED: 'false' }, 'other', async (ms) => { waits.push(ms); });
  assert.equal(delay, 0);
  assert.deepEqual(waits, []);
});

test('applyCronStagger does not sleep for a zero-delay worker', async () => {
  const waits = [];
  const delay = await applyCronStagger({}, 'buddies', async (ms) => { waits.push(ms); });
  assert.equal(delay, 0);
  assert.deepEqual(waits, []);
});

test('collector completion gate waits for the current-minute successful collector write', async () => {
  let reads = 0;
  const db = {
    prepare() {
      return { async first() {
        reads += 1;
        return reads === 1
          ? { last_run_at: 59_000, last_success_at: 59_000, last_error: null }
          : { last_run_at: 60_000, last_success_at: 60_000, last_error: null };
      } };
    },
  };
  const result = await waitForCollectorCompletion(
    { BUDDIES_DB: db, COLLECTOR_PRIORITY_WAIT_MS: 100, COLLECTOR_PRIORITY_POLL_MS: 1 },
    60_000,
  );
  assert.equal(result.ready, true);
  assert.equal(reads, 2);
});

test('collector completion gate skips downstream work when collection has not succeeded', async () => {
  const db = { prepare() {
    return { async first() { return { last_run_at: 59_000, last_success_at: 59_000, last_error: null }; } };
  } };
  const result = await waitForCollectorCompletion(
    { BUDDIES_DB: db, COLLECTOR_PRIORITY_WAIT_MS: 0 },
    60_000,
  );
  assert.deepEqual(result, { ready: false, reason: 'collector-not-ready', targetMinute: 60_000 });
});
