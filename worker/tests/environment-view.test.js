import assert from 'node:assert/strict';
import test from 'node:test';

import { environmentView } from '../../packages/sh-shared/environment-view.mjs';
import { withMinuteD1WriteThrottling } from '../src/minute-d1-write-throttle.js';
import { sampledSuccessDue } from '../src/sampled-success-log.js';

function database() {
  return {
    prepare(sql) {
      return { sql, bind() { return this; } };
    },
  };
}

test('environment views safely shadow non-configurable Cloudflare bindings', () => {
  const original = database();
  const replacement = database();
  const env = { marker: 1 };
  Object.defineProperty(env, 'DB', {
    value: original,
    enumerable: true,
    configurable: false,
    writable: false,
  });

  const view = environmentView(env, { DB: replacement });
  assert.equal(view.DB, replacement);
  assert.equal(view.marker, 1);
  assert.equal(Object.getPrototypeOf(view), env);
  assert.equal(Object.getOwnPropertyDescriptor(view, 'DB').configurable, true);
});

test('minute D1 throttling does not Proxy the environment object', () => {
  const original = database();
  const env = {};
  Object.defineProperty(env, 'MINUTE_DB', {
    value: original,
    enumerable: true,
    configurable: false,
    writable: false,
  });

  const active = withMinuteD1WriteThrottling(env);
  assert.doesNotThrow(() => active.MINUTE_DB.prepare('SELECT 1'));
  assert.notEqual(active.MINUTE_DB, original);
  assert.equal(Object.getPrototypeOf(active), env);
});

test('success log sampling is deterministic and staggerable', () => {
  const hour = 60 * 60_000;
  assert.equal(sampledSuccessDue(hour, 60, 0), true);
  assert.equal(sampledSuccessDue(hour + 10 * 60_000, 60, 10), true);
  assert.equal(sampledSuccessDue(hour + 11 * 60_000, 60, 10), false);
});
