import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { TRACK_HISTORY_SQL } from '../functions/lib/track-history-handler.js';
import {
  TRACK_LIKE_HISTORY_SQL,
  TRACK_LIKE_QUEUE_SQL,
  TRACK_LIKE_REALTIME_SQL,
} from '../functions/lib/track-likes.js';

const activeSql = [
  TRACK_HISTORY_SQL,
  TRACK_LIKE_HISTORY_SQL,
  TRACK_LIKE_QUEUE_SQL,
  TRACK_LIKE_REALTIME_SQL,
].join('\n');

test('active history and like SQL use Spotify and ISRC without Apple Music columns', () => {
  assert.doesNotMatch(activeSql, /apple[_-]?music/i);
  assert.match(TRACK_HISTORY_SQL, /spotify_id/);
  assert.match(TRACK_HISTORY_SQL, /isrc/);
});

test('host history no longer exposes general profiles or raw comments and events', () => {
  const source = readFileSync(new URL('../functions/api/host-history.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /sh_host_profile_snapshots/);
  assert.doesNotMatch(source, /sh_host_comments/);
  assert.doesNotMatch(source, /sh_host_raw_events/);
  assert.match(source, /general profile history retired/);
});
