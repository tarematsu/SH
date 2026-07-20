import assert from 'node:assert/strict';
import test from 'node:test';

import { processReadModelMessage } from '../src/read-model-entry.js';

test('missing metadata Queue preserves inline preparation before checkpointed writes', async () => {
  const readModel = {
    channel: { channel_id: 10, observed_at: 20, presentation: {} },
    queue: {
      station_id: 30,
      queue_id: 40,
      start_time: 50,
      value: {
        tracks: [{
          spotify_id: 'spotify-gap',
          title: null,
          artist: 'Artist',
          album_name: 'Album',
          thumbnail_url: 'cover',
        }],
      },
    },
    collector: { collector_id: 'collector', updated_at: 20 },
  };
  const prepared = { ...readModel, prepared: true };
  const calls = [];
  const originalLog = console.log;
  console.log = () => {};
  try {
    assert.deepEqual(await processReadModelMessage({}, {
      message_type: 'stationhead-read-model',
      message_version: 1,
      observed_at: 20,
      job_id: 'read-model:10:20',
      read_model: readModel,
    }, {
      async prepareReadModelForWrite(_env, value) {
        calls.push(['prepare', value]);
        return prepared;
      },
      async writePreparedReadModel(_env, value) {
        calls.push(['write', value]);
      },
    }), { deferred: false });
  } finally {
    console.log = originalLog;
  }

  assert.deepEqual(calls, [
    ['prepare', readModel],
    ['write', prepared],
  ]);
});
