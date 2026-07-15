import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const middleware = readFileSync(new URL('../functions/api/_middleware.js', import.meta.url), 'utf8');

test('playback middleware restores missing metadata from the buddies database', () => {
  assert.match(middleware, /url\.pathname === '\/api\/playback'/);
  assert.match(middleware, /FROM sh_queue_read_model_current/);
  assert.match(middleware, /FROM sh_track_metadata/);
  assert.match(middleware, /spotify_id,isrc,title,artist,thumbnail_url/);
  assert.match(middleware, /title = track\.title \|\| meta\.title \|\| null/);
  assert.match(middleware, /artist = track\.artist \|\| meta\.artist \|\| null/);
  assert.match(middleware, /thumbnailUrl = track\.thumbnail_url \|\| meta\.thumbnail_url \|\| null/);
});

test('playback metadata fallback stays bounded and fails open', () => {
  assert.match(middleware, /\.slice\(0, 80\)/);
  assert.match(middleware, /console\.error\('playback metadata enrichment failed'/);
  assert.match(middleware, /return origin/);
});
