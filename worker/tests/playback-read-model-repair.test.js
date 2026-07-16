import assert from 'node:assert/strict';
import test from 'node:test';

import { repairPlaybackReadModels } from '../src/buddies-facts-sync.js';

function queueDb(localMetadata, updates) {
  return {
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
          if (/FROM sh_track_metadata/.test(sql)) return { results: localMetadata };
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
}

function metadataDb(rows, calls) {
  return {
    prepare(sql) {
      const statement = {
        bindings: [],
        bind(...bindings) { this.bindings = bindings; return this; },
        async all() {
          calls.push({ sql, bindings: this.bindings });
          return { results: rows };
        },
      };
      return statement;
    },
  };
}

test('metadata sync repairs an already persisted sparse playback queue', async () => {
  const updates = [];
  const db = queueDb([{
    spotify_id: 'sp1',
    isrc: 'JPX1',
    title: 'Song',
    artist: 'Artist',
    thumbnail_url: 'https://img.example/cover.jpg',
    fetched_at: 10,
  }], updates);

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

test('playback repair completes partial local metadata from the source database', async () => {
  const updates = [];
  const sourceCalls = [];
  const minuteDb = queueDb([{
    spotify_id: 'sp1',
    isrc: 'JPX1',
    title: 'Local Song',
    artist: null,
    thumbnail_url: null,
    fetched_at: 10,
  }], updates);
  const buddiesDb = metadataDb([{
    spotify_id: 'sp1',
    isrc: 'JPX1',
    title: 'Fresh Song',
    artist: 'Fresh Artist',
    thumbnail_url: 'https://img.example/fresh.jpg',
    fetched_at: 20,
  }], sourceCalls);

  const result = await repairPlaybackReadModels({
    MINUTE_DB: minuteDb,
    BUDDIES_DB: buddiesDb,
  });

  assert.deepEqual(result, { repaired: 1, skipped: false });
  assert.equal(sourceCalls.length, 1);
  assert.deepEqual(sourceCalls[0].bindings, ['JPX1', 'sp1']);
  const saved = JSON.parse(updates[0].bindings[0]);
  assert.equal(saved.tracks[0].title, 'Local Song');
  assert.equal(saved.tracks[0].artist, 'Fresh Artist');
  assert.equal(saved.tracks[0].thumbnail_url, 'https://img.example/fresh.jpg');
});
