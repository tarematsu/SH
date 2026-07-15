import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const scriptUrl = new URL('../scripts/consolidate-track-metadata.mjs', import.meta.url);

test('D1 metadata consolidation copies and verifies ISRC', async () => {
  const source = await readFile(scriptUrl, 'utf8');
  assert.match(source, /'spotify_id', 'isrc', 'title'/);
  assert.match(source, /isrc=COALESCE\(sh_track_metadata\.isrc,excluded\.isrc\)/);
  assert.match(source, /function verifyPage\(database, sourceRows\)/);
  assert.match(source, /Target metadata ISRC mismatch/);
  assert.match(source, /verified_isrc_rows/);
});

test('D1 metadata consolidation verifies by Spotify alias without changing the physical key', async () => {
  const source = await readFile(scriptUrl, 'utf8');
  assert.match(source, /ON CONFLICT\(spotify_id\) DO UPDATE SET/);
  assert.match(source, /SELECT spotify_id,isrc FROM sh_track_metadata/);
});
