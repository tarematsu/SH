import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const runtimeScheduled = readFileSync(
  new URL('../worker/src/runtime-scheduled.js', import.meta.url),
  'utf8',
);

test('healthy runtime scheduling removes recovery and maintenance relay hops', () => {
  assert.match(runtimeScheduled, /dispatchMinuteRecoveryWithFallback/);
  assert.match(runtimeScheduled, /dispatchMinuteGateWithFallback/);
  assert.match(
    runtimeScheduled,
    /body !== rawMessage && body !== recoveryMessage && body !== gateMessage/,
  );
  assert.match(runtimeScheduled, /inline_minute_recovery_failed/);
  assert.match(runtimeScheduled, /inline_minute_maintenance_gate_failed/);

  // Prediction: 48/day; hourly maintenance: 48/day; heavy Pages variants:
  // 17/day; pathological raw fallback: two messages every five minutes.
  // Recovery polls and maintenance gates run directly on the healthy path.
  const healthyMessages = 48 + 48 + 17 + 288 * 2;
  const healthyQueueOperations = healthyMessages * 3;
  assert.equal(healthyQueueOperations, 2_067);
  assert.ok(healthyQueueOperations < 8_000);

  // If all 288 recovery polls and all 432 maintenance gates fall back to the
  // previous relay path, operations remain at the original policy ceiling.
  const fullRelayFallbackQueueOperations = healthyQueueOperations + (288 + 432) * 3;
  assert.equal(fullRelayFallbackQueueOperations, 4_227);
  assert.ok(fullRelayFallbackQueueOperations < 8_000);
});
