import assert from 'node:assert/strict';
import test from 'node:test';

import { processIngestFactTask } from '../src/ingest-fact-stage.js';
import { minuteFactQueueMessage } from '../src/minute-facts-queue.js';

const observedAt = 1_784_000_000_000;

test('isolated ingest fact stage preserves comments and finalize ordering', async () => {
  const comments = [];
  const finalized = [];
  const fact = {
    observedAt,
    snapshot: { channel_id: 10, station_id: 20 },
    queue: { station_id: 20, tracks: [] },
    comments: { commentsSaved: 0, degraded: false },
    auth: { authToken: 'token', deviceUid: 'device' },
    collectorState: {
      authToken: 'token',
      deviceUid: 'device',
      lastRunAt: observedAt,
      lastSuccessAt: observedAt + 1,
    },
    options: {
      collectComments: false,
      readModelPresentationOnly: true,
      readModel: {
        channel: { channel_id: 10, observed_at: observedAt, presentation: {} },
        queue: { station_id: 20 },
        collector: { collector_id: 'cloudflare-worker', updated_at: observedAt },
      },
    },
  };
  const result = await processIngestFactTask({
    DB: {},
    COMMENTS_QUEUE: { async send(body) { comments.push(body); } },
  }, {
    message_type: 'stationhead-ingest-fact',
    message_version: 1,
    fact,
  }, {
    async handoffMinuteFactJob(activeEnv, input, options) {
      const body = minuteFactQueueMessage(input, options);
      await activeEnv.MINUTE_FACT_QUEUE.send(body, { contentType: 'json' });
      return { enqueued: true, outbox_pending: false, minute_at: body.minute_at };
    },
    async sendFinalize(body) { finalized.push(body); },
  });

  assert.equal(comments.length, 1);
  assert.equal(comments[0].message_type, 'stationhead-comments-task');
  assert.equal(comments[0].minute_fact.read_model, null);
  assert.equal(finalized.length, 1);
  assert.equal(finalized[0].message_type, 'stationhead-ingest-finalize');
  assert.equal(finalized[0].read_model.message_type, 'stationhead-read-model');
  assert.equal(result.event, 'ingest_fact_completed');
});
