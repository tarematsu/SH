import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { isrcMetadataRepairRows, metadataNeedsRefresh } from '../src/shared.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const source = readFileSync(new URL('../src/track-metadata.js', import.meta.url), 'utf8');

test('complete metadata never needs a refresh', () => {
  assert.equal(metadataNeedsRefresh({
    title: 'Interlude #1',
    artist: '櫻坂46',
    fetched_at: 1,
  }, 'spotify-track', DAY_MS * 10), false);
});

test('recent incomplete metadata is not fetched every minute', () => {
  const now = DAY_MS * 10;
  assert.equal(metadataNeedsRefresh({
    title: 'Interlude #1',
    artist: null,
    fetched_at: now - 60_000,
  }, 'spotify-track', now), false);
});

test('incomplete metadata is retried after one day', () => {
  const now = DAY_MS * 10;
  assert.equal(metadataNeedsRefresh({
    title: 'Interlude #1',
    artist: null,
    fetched_at: now - DAY_MS,
  }, 'spotify-track', now), true);
});

test('metadata without a successful fetch timestamp is eligible immediately', () => {
  assert.equal(metadataNeedsRefresh({
    title: 'Interlude #1',
    artist: null,
  }, 'spotify-track', DAY_MS * 10), true);
});

test('ISRC peer metadata becomes a complete D1 repair row', () => {
  const rows = isrcMetadataRepairRows([{
    spotify_id: 'spotify-missing',
    peer_spotify_id: 'spotify-complete',
    isrc: 'JPABC2600001',
    title: 'Interlude #1',
    artist: '櫻坂46',
    thumbnail_url: 'https://image.example/cover.jpg',
  }], 12345);
  assert.deepEqual(rows, [{
    spotify_id: 'spotify-missing',
    isrc: 'JPABC2600001',
    title: 'Interlude #1',
    artist: '櫻坂46',
    display_title: 'Interlude #1 — 櫻坂46',
    thumbnail_url: 'https://image.example/cover.jpg',
    spotify_url: 'https://open.spotify.com/track/spotify-missing',
    source: 'isrc_peer',
    fetched_at: 12345,
    raw: {
      resolved_from_spotify_id: 'spotify-complete',
      isrc: 'JPABC2600001',
    },
  }]);
  assert.equal(metadataNeedsRefresh(rows[0], rows[0].spotify_id, 99999), false);
});

test('ISRC repair uses current queue values instead of scanning candidate history', () => {
  assert.match(source, /WITH candidates\(spotify_id,isrc\) AS \(\s*VALUES/);
  assert.doesNotMatch(source, /FROM sh_queue_items candidate/);
  assert.match(source, /JOIN sh_queue_items peer\s+ON peer\.isrc=candidates\.isrc/);
});

test('repair updates only incomplete D1 metadata rows', () => {
  assert.match(source, /ON CONFLICT\(spotify_id\) DO UPDATE SET/);
  assert.match(source, /WHERE sh_track_metadata\.title IS NULL/);
  assert.match(source, /OR sh_track_metadata\.artist GLOB 'JP\[A-Z0-9\]\*'/);
});

test('Spotify failures receive a retry cooldown', () => {
  assert.match(source, /FAILURE_RETRY_MS = 15 \* 60 \* 1000/);
  assert.match(source, /cacheMetadataState\(spotifyId, now \+ FAILURE_RETRY_MS/);
});
