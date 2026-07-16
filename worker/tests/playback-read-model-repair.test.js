import assert from 'node:assert/strict';
import test from 'node:test';

import { repairPlaybackReadModels } from '../src/buddies-facts-sync.js';

test('metadata sync repairs an already persisted sparse playback queue', async () => {
  const updates = [];
  const db = {
    prepare(sql) {
      const statement = {
        bindings: [],
        bind(...bindings) { this.bindings = bindings; return this; },
        async all() {
          if (/FROM sh_queue_read_model_current/.test(sql)) {
            return { results: [{
              channel_id: 1,
              queue_json: JSON.stringify({ tracks: [{
                position: 0,
                spotify_id: 'sp1',
                isrc: 'JPX1',
                title: null,
                artist: null,
                thumbnail_url: null,
              }] }),
            }] };
          }
          if (/FROM sh_track_metadata/.test(sql)) {
            return { results: [{
              spotify_id: 'sp1',
              isrc: 'JPX1',
              title: 'Song',
              artist: 'Artist',
              thumbnail_url: 'https://img.example/cover.jpg',
              fetched_at: 10,
            }] };
          }
          return { results: [] };
        },
        async run() {
          updates.push({ sql, bindings: this.bindings });
          return { meta: { changes: 1 } };
        },
      };
      return statement;
    },
  };

  const result = await repairPlaybackReadModels({ MINUTE_DB: db });

  assert.deepEqual(result, { repaired: 1, skipped: false });
  assert.equal(updates.length, 1);
  const saved = JSON.parse(updates[0].bindings[0]);
  assert.deepEqual(saved.tracks[0], {
    position: 0,
    spotify_id: 'sp1',
    isrc: 'JPX1',
    title: 'Song',
    artist: 'Artist',
    album_name: null,
    thumbnail_url: 'https://img.example/cover.jpg',
  });
});
