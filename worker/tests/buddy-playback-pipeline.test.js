import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  buddyPlaybackPipelineSlot,
  buddyPlaybackStateHash,
  parseBuddyPlaybackPipelinePayload,
} from '../src/buddy-playback-pipeline.js';
import {
  enrichQueueMetadata,
  resetMetadataFailureCache,
} from '../src/buddy-playback-metadata.js';

const BASE = Date.UTC(2026, 0, 1, 0, 0, 0);

const channel = {
  alias: 'buddy46',
  current_station: {
    id: 46,
    is_broadcasting: true,
    broadcast: {
      broadcasters: [{ is_host: true, account_id: 9, account: { handle: 'host46' } }],
    },
    queue: {
      id: 99,
      station_id: 46,
      start_time: 300_000,
      is_paused: false,
      queue_tracks: [{
        id: 1,
        track: {
          id: 2,
          spotify_id: 'sp1',
          duration: 180_000,
          isrc: 'JPX',
          title: 'Song',
          artist: { name: 'Artist' },
        },
      }],
    },
  },
};

test('buddy46 pipeline owns three non-overlapping slots per half hour', () => {
  for (const minute of [0, 5, 15, 30, 35, 45]) {
    assert.equal(buddyPlaybackPipelineSlot(BASE + minute * 60_000), true, `minute ${minute}`);
  }
  for (const minute of [10, 20, 25, 40, 50, 55]) {
    assert.equal(buddyPlaybackPipelineSlot(BASE + minute * 60_000), false, `minute ${minute}`);
  }
});

test('parse stage preserves the existing compact playback state serialization', async () => {
  const parsed = parseBuddyPlaybackPipelinePayload(JSON.stringify(channel), {
    alias: 'buddy46',
    maxTracks: 80,
  });

  assert.equal(parsed.queue.station_id, 46);
  assert.equal(parsed.queue.queue_id, 99);
  assert.equal(parsed.queue.tracks.length, 1);
  assert.deepEqual(JSON.parse(parsed.stateJson), {
    station_id: 46,
    queue_id: 99,
    start_time: 300_000,
    is_paused: false,
    tracks: parsed.queue.tracks,
  });
  assert.equal(
    await buddyPlaybackStateHash(parsed.stateJson),
    createHash('sha256').update(parsed.stateJson).digest('hex'),
  );
});

test('metadata stage fetches at most one missing track and reports remaining work', async () => {
  resetMetadataFailureCache();
  const prepared = [];
  const db = {
    prepare(sql) {
      const statement = {
        sql,
        params: [],
        bind(...params) { this.params = params; return this; },
        async all() { return { results: [] }; },
        async run() { return { meta: { changes: 1 } }; },
      };
      prepared.push(statement);
      return statement;
    },
    async batch(statements) {
      return Promise.all(statements.map((statement) => statement.run()));
    },
  };
  const fetched = [];
  const result = await enrichQueueMetadata({ OTHER_DB: db }, {
    start_time: null,
    tracks: [
      { spotify_id: 'sp1', isrc: 'ISRC1', title: null, artist: null },
      { spotify_id: 'sp2', isrc: 'ISRC2', title: null, artist: null },
    ],
  }, 600_000, {
    metadataLimit: 1,
    returnDetails: true,
  }, async (track) => {
    fetched.push(track.spotify_id);
    return {
      spotify_id: track.spotify_id,
      isrc: track.isrc,
      title: `Title ${track.spotify_id}`,
      artist: 'Artist',
      display_title: `Title ${track.spotify_id} — Artist`,
      thumbnail_url: null,
      spotify_url: null,
      source: 'test',
      fetched_at: 600_000,
      raw: {},
    };
  });

  assert.deepEqual(fetched, ['sp1']);
  assert.equal(result.fetched, 1);
  assert.equal(result.remaining, 1);
  assert.equal(result.metadata.get('sp1').title, 'Title sp1');
  assert.ok(prepared.some(({ sql }) => sql.includes('INSERT INTO sh_buddy_track_metadata')));
});
