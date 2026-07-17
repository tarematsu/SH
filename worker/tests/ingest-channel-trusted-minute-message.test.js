import assert from 'node:assert/strict';
import test from 'node:test';

import {
  capturedReadModelEnvelope,
  commentsTaskForMinuteFact,
  readModelEnvelopeForMinuteFact,
} from '../src/ingest-channel-entry.js';
import { minuteFactQueueMessage } from '../src/minute-facts-queue.js';

function minuteMessage() {
  const observedAt = 1_784_000_012_345;
  const queue = {
    station_id: 123,
    queue_id: 456,
    start_time: observedAt - 60_000,
    is_paused: false,
    tracks: Array.from({ length: 60 }, (_, position) => ({
      position,
      spotify_id: `track-${position}`,
      title: `Song ${position}`,
      artist: 'Artist',
      album_name: null,
      thumbnail_url: null,
    })),
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

test('trusted envelope hydrates the compact read model in place', () => {
  const body = minuteMessage();
  const compactReadModel = body.read_model;
  const compactQueue = compactReadModel.queue;
  const envelope = readModelEnvelopeForMinuteFact(
    { observed_at: 1_784_000_000_000, auth: { authToken: 'token' } },
    body,
    { trusted: true },
  );

  assert.equal(envelope.read_model, compactReadModel);
  assert.equal(envelope.read_model.queue, compactQueue);
  assert.equal(envelope.read_model.queue.value, body.payload.queue);
  assert.equal(envelope.read_model.queue.value.tracks.length, 60);
});

test('captured read-model envelope is reused only for the matching minute identity', () => {
  const envelope = { message_type: 'stationhead-read-model' };
  const capture = { channelId: 10, minuteAt: 1_784_000_000_000, envelope };

  assert.equal(capturedReadModelEnvelope({
    channel_id: '10',
    minute_fact_job_minute_at: '1784000000000',
  }, capture), envelope);
  assert.equal(capturedReadModelEnvelope({
    channel_id: 10,
    minute_fact_job_minute_at: 1_784_000_060_000,
  }, capture), null);
  assert.throws(
    () => capturedReadModelEnvelope({ channel_id: 10 }, capture),
    /current minute fact identity is missing/,
  );
});

test('comments handoff mutates only the explicitly trusted in-memory message', () => {
  const copiedBody = minuteMessage();
  const copiedReadModel = copiedBody.read_model;
  const copiedTask = commentsTaskForMinuteFact(
    { observed_at: 1, station_id: 123, auth: {} },
    copiedBody,
  );

  assert.notEqual(copiedTask.minute_fact, copiedBody);
  assert.equal(copiedBody.read_model, copiedReadModel);
  assert.equal(copiedTask.minute_fact.read_model, null);

  const trustedBody = minuteMessage();
  const trustedTask = commentsTaskForMinuteFact(
    { observed_at: 1, station_id: 999, auth: {} },
    trustedBody,
    { inPlace: true },
  );

  assert.equal(trustedTask.minute_fact, trustedBody);
  assert.equal(trustedBody.read_model, null);
  assert.equal(trustedTask.observed_at, trustedBody.payload.observedAt);
  assert.equal(trustedTask.station_id, trustedBody.payload.snapshot.station_id);
});