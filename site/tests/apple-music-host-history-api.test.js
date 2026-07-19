import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('host session history no longer selects Apple Music track fields', () => {
  const source = readFileSync(new URL('../functions/api/host-history.js', import.meta.url), 'utf8');
  const sessionBlock = source.slice(
    source.indexOf("if (mode === 'session')"),
    source.indexOf('const summary = await cachedHostSummary'),
  );
  assert.doesNotMatch(sessionBlock, /apple_music_id/i);
  assert.match(sessionBlock, /stationhead_track_id,spotify_id,deezer_id/);
  assert.match(sessionBlock, /isrc,duration_ms,preview_url,bite_count/);
});
