import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SAKURAZAKA_CRON,
  SAKURAZAKA_CYCLE_MESSAGE,
  runSakurazakaScheduled,
} from '../src/sakurazaka-entry.js';

test('Sakurazaka cron dispatches one compact task to its dedicated queue', async () => {
  const sent = [];
  const result = await runSakurazakaScheduled({
    cron: SAKURAZAKA_CRON,
    scheduledTime: 1_700_000_000_000,
  }, {
    SAKURAZAKA_QUEUE: {
      async send(body, options) {
        sent.push({ body, options });
      },
    },
  });

  assert.deepEqual(result, { dispatched: true, scheduled_at: 1_700_000_000_000 });
  assert.deepEqual(sent, [{
    body: {
      message_type: SAKURAZAKA_CYCLE_MESSAGE,
      message_version: 1,
      scheduled_at: 1_700_000_000_000,
    },
    options: { contentType: 'json' },
  }]);
});

test('Sakurazaka entry rejects unrelated cron expressions without dispatch', async () => {
  let sent = false;
  const result = await runSakurazakaScheduled({
    cron: '* * * * *',
    scheduledTime: 1_700_000_000_000,
  }, {
    SAKURAZAKA_QUEUE: { async send() { sent = true; } },
  });

  assert.equal(sent, false);
  assert.deepEqual(result, {
    skipped: true,
    reason: 'unsupported-cron',
    cron: '* * * * *',
  });
});
