import assert from 'node:assert/strict';
import test from 'node:test';

import commentsWorker from '../src/comments-entry.js';
import worker, {
  compactCommentsEnv,
  compactCommittedMetadataMessage,
} from '../src/comments-cpu-entry.js';

function metadataMessage() {
  return {
    message_type: 'stationhead-track-metadata',
    message_version: 1,
    task: 'committed-enrichment',
    extra: 'unused',
    job: {
      jobId: 'minute-fact:10:1784000000000',
      options: { enrichTrackMetadata: true },
      payload: {
        observedAt: 1_784_000_000_000,
        snapshot: { channel_id: 10, station_id: 20, title: 'unused' },
        comments: { commentCount: 9, raw: { unused: true } },
        queue: {
          station_id: 20,
          raw: { unused: true },
          tracks: [
            {
              spotify_id: 'spotify-a',
              isrc: 'JPA123456789',
              title: 'unused',
              artist: 'unused',
              raw: { unused: true },
            },
            { spotify_id: 'spotify-only', title: 'spotify-only' },
            { isrc: 'JPB123456789', title: 'isrc-only' },
            { title: 'no metadata identity' },
            null,
          ],
        },
      },
    },
  };
}

test('comments metadata handoff retains only fields used by enrichment', () => {
  const compact = compactCommittedMetadataMessage(metadataMessage());

  assert.deepEqual(compact, {
    message_type: 'stationhead-track-metadata',
    message_version: 1,
    task: 'committed-enrichment',
    job: {
      jobId: 'minute-fact:10:1784000000000',
      payload: {
        observedAt: 1_784_000_000_000,
        queue: {
          tracks: [
            { spotify_id: 'spotify-a', isrc: 'JPA123456789' },
            { spotify_id: 'spotify-only' },
            { isrc: 'JPB123456789' },
          ],
        },
      },
    },
  });
  assert.equal(Object.hasOwn(compact.job, 'options'), false);
  assert.equal(Object.hasOwn(compact.job.payload, 'snapshot'), false);
  assert.equal(Object.hasOwn(compact.job.payload, 'comments'), false);
});

test('comments environment wrapper compacts only metadata queue sends', async () => {
  const sent = [];
  const env = {
    DB: { name: 'buddies' },
    TRACK_METADATA_QUEUE: {
      async send(body, options) { sent.push({ body, options }); },
    },
  };
  const active = compactCommentsEnv(env);
  const message = metadataMessage();

  assert.notEqual(active, env);
  assert.equal(compactCommentsEnv(env), active);
  assert.equal(active.DB, env.DB);
  await active.TRACK_METADATA_QUEUE.send(message, { contentType: 'json' });

  assert.equal(sent.length, 1);
  assert.notEqual(sent[0].body, message);
  assert.deepEqual(sent[0].body.job.payload.queue.tracks, [
    { spotify_id: 'spotify-a', isrc: 'JPA123456789' },
    { spotify_id: 'spotify-only' },
    { isrc: 'JPB123456789' },
  ]);
  assert.deepEqual(sent[0].options, { contentType: 'json' });

  const unrelated = { message_type: 'other' };
  assert.equal(compactCommittedMetadataMessage(unrelated), unrelated);
});

test('comments environment cache refreshes when the queue binding changes', () => {
  const env = { TRACK_METADATA_QUEUE: { send() {} } };
  const first = compactCommentsEnv(env);
  env.TRACK_METADATA_QUEUE = { send() {} };
  const second = compactCommentsEnv(env);

  assert.notEqual(second, first);
  assert.equal(compactCommentsEnv(env), second);
});

test('comments fetch keeps the original no-op handler', () => {
  assert.equal(worker.fetch, commentsWorker.fetch);
});
