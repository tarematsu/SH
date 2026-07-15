import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { attachBuddyMetadata } from '../worker/src/buddy-playback-metadata.js';
import { fetchTrackMetadata } from '../worker/src/track-metadata.js';

const migrationUrl = new URL('../database/migrations/037_isrc_track_metadata.sql', import.meta.url);
const schemaUrl = new URL('../database/schema.sql', import.meta.url);
const ingestUrl = new URL('../site/functions/api/ingest.js', import.meta.url);

test('track metadata schema stores normalized ISRC values', async () => {
  const schema = await readFile(schemaUrl, 'utf8');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS sh_track_metadata[\s\S]*?isrc TEXT/);
  assert.match(schema, /idx_sh_track_metadata_isrc_fetched/);
});

test('migration backfills ISRC and keeps future metadata writes covered', async () => {
  const migration = await readFile(migrationUrl, 'utf8');
  assert.match(migration, /ALTER TABLE sh_track_metadata ADD COLUMN isrc TEXT/);
  assert.match(migration, /UPPER\(TRIM\(items\.isrc\)\)/);
  assert.match(migration, /trg_sh_track_metadata_fill_isrc_insert/);
});

test('optimized metadata ingest accepts ISRC without changing spotify compatibility', async () => {
  const ingest = await readFile(ingestUrl, 'utf8');
  assert.match(ingest, /spotify_id,isrc,title,artist/);
  assert.match(ingest, /isrc=COALESCE\(excluded\.isrc,sh_track_metadata\.isrc\)/);
  assert.match(ingest, /ON CONFLICT\(spotify_id\)/);
});

test('Spotify metadata fetch carries the queue ISRC into persistence', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response(JSON.stringify({
    title: 'Song by Artist',
    author_name: 'Artist',
    thumbnail_url: 'cover',
  }), { status: 200, headers: { 'content-type': 'application/json' } });

  const row = await fetchTrackMetadata(
    { spotify_id: 'sp1', isrc: ' jpx123456789 ' },
    { collectionSignal: null, requestTimeoutMs: 1_000 },
  );
  assert.equal(row.isrc, 'JPX123456789');
  assert.equal(row.spotify_id, 'sp1');
});

test('buddy playback can resolve metadata by ISRC while preserving legacy Spotify maps', () => {
  const queue = { tracks: [{ spotify_id: 'new-sp', isrc: 'JPX123456789', thumbnail_url: null }] };
  const isrcRow = { title: 'Song', artist: 'Artist', thumbnail_url: 'isrc-cover' };
  const [fromIsrc] = attachBuddyMetadata(queue, new Map([['isrc:JPX123456789', isrcRow]]));
  assert.equal(fromIsrc.thumbnail_url, 'isrc-cover');

  const [fromLegacy] = attachBuddyMetadata(queue, new Map([['new-sp', { ...isrcRow, thumbnail_url: 'legacy-cover' }]]));
  assert.equal(fromLegacy.thumbnail_url, 'legacy-cover');
});
