import assert from 'node:assert/strict';
import test from 'node:test';

import { readModelEnvelopeForMinuteFact } from '../src/ingest-channel-entry.js';
import { minuteFactQueueMessage } from '../src/minute-facts-queue.js';

function minuteMessage() {
  const observedAt = 1_784_000_012_345;
  const queue = {
    station_id: 123,
    queue_id: 456,
    start_time: observedAt - 60_000,
    is_paused: false,
    tracks: [{ position: 0, spotify_id: 'track', title: 'Song', artist: 'Artist' }],
  };
  return minuteFactQueueMessage({
    observedAt,
    snapshot: { channel_id: 10, station_id: 123, listener_count: 9 },
    queue,
  }, {
    readModelPresentationOnly: true,
    readModel: {
      channel: { channel_id: 10, observed_at: observedAt, presentation: { description: 'kept' } },
      queue: {
        station_id: 123,
        queue_id: 456,
        start_time: queue.start_time,
        is_paused: false,
        value: queue,
      },
      collector: {
        collector_id: 'cloudflare-worker',
        last_run_at: observedAt,
        last_success_at: observedAt,
        last_error_present: false,
        updated_at: observedAt,
      },
    },
  });
}

test('trusted ingest minute message produces the same read-model envelope', () => {
  const rawMessage = { observed_at: 1_784_000_000_000, auth: { authToken: 'token' } };
  const body = minuteMessage();

  const validated = readModelEnvelopeForMinuteFact(rawMessage, body);
  const trusted = readModelEnvelopeForMinuteFact(rawMessage, body, { trusted: true });

  assert.deepEqual(trusted, validated);
});

test('trusted ingest path still rejects mismatched channel identity', () => {
  const body = minuteMessage();
  body.channel_id += 1;

  assert.throws(
    () => readModelEnvelopeForMinuteFact({ observed_at: 1 }, body, { trusted: true }),
    /invalid trusted minute fact queue message/,
  );
});
