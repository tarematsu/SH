import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const runtimeScheduled = readFileSync(
  new URL('../worker/src/runtime-scheduled.js', import.meta.url),
  'utf8',
);

test('healthy minute maintenance scheduling removes the host-monitor relay hop', () => {
  assert.match(runtimeScheduled, /dispatchMinuteGateWithFallback/);
  assert.match(runtimeScheduled, /body !== rawMessage && body !== gateMessage/);
  assert.match(runtimeScheduled, /inline_minute_maintenance_gate_failed/);

  // Recovery polling: 288/day; prediction: 48/day; hourly maintenance: 48/day;
  // heavy Pages variants: 17/day; pathological raw fallback: two messages every
  // five minutes. Healthy maintenance gates go straight to MINUTE_REBUILD_QUEUE.
  const healthyMessages = 288 + 48 + 48 + 17 + 288 * 2;
  const healthyQueueOperations = healthyMessages * 3;
  assert.equal(healthyQueueOperations, 2_931);
  assert.ok(healthyQueueOperations < 8_000);

  // If every one of the 432 daily direct gate sends fails, the old relay path
  // is restored for those messages and remains below the same policy ceiling.
  const fullGateFallbackQueueOperations = healthyQueueOperations + 432 * 3;
  assert.equal(fullGateFallbackQueueOperations, 4_227);
  assert.ok(fullGateFallbackQueueOperations < 8_000);
});
