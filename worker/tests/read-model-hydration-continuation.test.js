import assert from 'node:assert/strict';
import test from 'node:test';

import { processTrackMetadataTask } from '../src/track-metadata-entry.js';

function hydrationBody(readModel) {
  return {
    message_type: 'stationhead-track-metadata',
    message_version: 1,
    task: 'read-model-hydration',
    job_id: 'read-model:10:20',
    read_model: readModel,
  };
}

test('successful hydration skips the redundant preservation invocation', async () => {
  const hydrated = {
    queue: {
      value: {
        tracks: [{
          spotify_id: 'spotify-complete',
          title: 'Song',
          artist: 'Artist',
          album_name: 'Album',
          thumbnail_url: 'cover',
        }],
      },
    },
  };
  const enqueued = [];
  const result = await processTrackMetadataTask({}, hydrationBody({ queue: { value: { tracks: [] } } }), {
    hydrateReadModelMetadata: async () => hydrated,
    enqueueReadModelStage: async (task, value) => enqueued.push({ task, value }),
  });

  assert.equal(result.pending, true);
  assert.equal(result.next_task, 'read-model-write');
  assert.deepEqual(enqueued, [{ task: 'read-model-write', value: hydrated }]);
});

test('unresolved identified gaps retain the preservation invocation', async () => {
  const hydrated = {
    queue: {
      value: {
        tracks: [{
          spotify_id: 'spotify-gap',
          title: 'Song',
          artist: 'Artist',
          album_name: null,
          thumbnail_url: 'cover',
        }],
      },
    },
  };
  const enqueued = [];
  const result = await processTrackMetadataTask({}, hydrationBody(hydrated), {
    hydrateReadModelMetadata: async () => hydrated,
    enqueueReadModelStage: async (task, value) => enqueued.push({ task, value }),
  });

  assert.equal(result.next_task, 'read-model-preserve');
  assert.deepEqual(enqueued, [{ task: 'read-model-preserve', value: hydrated }]);
});
