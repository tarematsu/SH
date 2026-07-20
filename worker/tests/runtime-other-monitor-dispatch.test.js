import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OTHER_MONITOR_SUCCESS_MESSAGE,
  dispatchOtherMonitorStage,
} from '../src/runtime-other-monitor-dispatch.js';

const SCHEDULED_AT = Date.UTC(2026, 0, 1, 0, 0, 0);

test('runtime monitor stage defers its D1 checkpoint to a separate Queue invocation', async () => {
  const sent = [];
  let invalidations = 0;
  const result = await dispatchOtherMonitorStage({
    cron: '*/5 * * * *',
    scheduledTime: SCHEDULED_AT,
  }, {
    HOST_MONITOR_QUEUE: {
      async send(body, options) { sent.push({ body, options }); },
    },
  }, {}, {
    dependencies: { buddy: async () => 'buddy-dispatched' },
    healthApp: { invalidateHealthCache() { invalidations += 1; } },
  });

  assert.deepEqual(result, ['buddy-dispatched']);
  assert.deepEqual(sent, [{
    body: {
      message_type: OTHER_MONITOR_SUCCESS_MESSAGE,
      message_version: 1,
      at: SCHEDULED_AT,
    },
    options: { contentType: 'json' },
  }]);
  assert.equal(invalidations, 1);
});
