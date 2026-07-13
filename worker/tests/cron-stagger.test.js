import assert from 'node:assert/strict';
import test from 'node:test';

import { applyCronStagger, cronStaggerDelayMs, cronStaggerEnabled } from '../src/cron-stagger.js';

test('cronStaggerEnabled defaults to true and honors explicit disable', () => {
  assert.equal(cronStaggerEnabled({}), true);
  assert.equal(cronStaggerEnabled({ CRON_STAGGER_ENABLED: 'false' }), false);
  assert.equal(cronStaggerEnabled({ CRON_STAGGER_ENABLED: 'true' }), true);
});

test('cronStaggerDelayMs uses per-worker defaults and env overrides', () => {
  assert.equal(cronStaggerDelayMs({}, 'other'), 10_000);
  assert.equal(cronStaggerDelayMs({}, 'minute'), 5_000);
  assert.equal(cronStaggerDelayMs({}, 'buddies'), 0);
  assert.equal(cronStaggerDelayMs({ CRON_STAGGER_OTHER_MS: 5_000 }, 'other'), 5_000);
});

test('cronStaggerDelayMs clamps overrides to a sane maximum', () => {
  assert.equal(cronStaggerDelayMs({ CRON_STAGGER_MINUTE_MS: 999_999 }, 'minute'), 45_000);
  assert.equal(cronStaggerDelayMs({ CRON_STAGGER_MINUTE_MS: -5 }, 'minute'), 5_000);
});

test('applyCronStagger sleeps for the configured delay using the injected sleep function', async () => {
  const waits = [];
  const delay = await applyCronStagger({}, 'other', async (ms) => { waits.push(ms); });
  assert.equal(delay, 10_000);
  assert.deepEqual(waits, [10_000]);
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
