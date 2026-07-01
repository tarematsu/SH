import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeTrackRows } from '../site/functions/lib/track-history-merge.js';
import {
  bestText,
  looksLikePlaceholder,
} from '../site/functions/lib/track-history-text.js';

test('artist placeholders are treated as missing metadata', () => {
  assert.equal(looksLikePlaceholder('-'), true);
  assert.equal(looksLikePlaceholder('—'), true);
  assert.equal(bestText('-', '櫻坂46'), '櫻坂46');
  assert.equal(bestText('アーティスト不明'), null);
});

test('same recording merges by ISRC even when one artist is missing', () => {
  const rows = mergeTrackRows([
    {
      play_date: '2026-07-01',
      played_at: 1000,
      play_count: 2,
      title: 'Interlude #1',
      artist: '櫻坂46',
      spotify_id: 'spotify-a',
      isrc: 'JPABC2600001',
      spotify_url: 'https://open.spotify.com/track/spotify-a',
    },
    {
      play_date: '2026-07-01',
      played_at: 2000,
      play_count: 3,
      title: 'Interlude #1',
      artist: '-',
      isrc: 'jpabc2600001',
    },
  ]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].play_count, 5);
  assert.equal(rows[0].artist, '櫻坂46');
  assert.equal(rows[0].track_key, 'isrc:JPABC2600001');
  assert.equal(rows[0].isrc, 'JPABC2600001');
  assert.equal(rows[0].spotify_id, 'spotify-a');
});

test('identifier bridge merges partial Spotify and ISRC observations', () => {
  const rows = mergeTrackRows([
    {
      play_date: '2026-07-01',
      played_at: 1000,
      play_count: 1,
      title: 'Interlude #1',
      artist: '櫻坂46',
      spotify_id: 'spotify-a',
      isrc: 'JPABC2600001',
    },
    {
      play_date: '2026-07-01',
      played_at: 2000,
      play_count: 1,
      title: 'Interlude #1',
      artist: '-',
      spotify_id: 'spotify-a',
    },
    {
      play_date: '2026-07-01',
      played_at: 3000,
      play_count: 1,
      title: 'Interlude #1',
      artist: null,
      spotify_id: 'spotify-b',
      isrc: 'JPABC2600001',
    },
  ]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].play_count, 3);
  assert.equal(rows[0].artist, '櫻坂46');
  assert.deepEqual(new Set(rows[0].source_ids), new Set(['spotify-a', 'spotify-b', 'JPABC2600001']));
});

test('missing-artist rows without ids only merge when the title has one resolved artist', () => {
  const unique = mergeTrackRows([
    { play_date: '2026-07-01', played_at: 1000, play_count: 1, title: 'Interlude #1', artist: '櫻坂46' },
    { play_date: '2026-07-01', played_at: 2000, play_count: 1, title: 'Interlude #1', artist: '-' },
  ]);
  assert.equal(unique.length, 1);
  assert.equal(unique[0].play_count, 2);
  assert.equal(unique[0].artist, '櫻坂46');

  const ambiguous = mergeTrackRows([
    { play_date: '2026-07-01', played_at: 1000, play_count: 1, title: 'Intro', artist: 'Artist A' },
    { play_date: '2026-07-01', played_at: 2000, play_count: 1, title: 'Intro', artist: 'Artist B' },
    { play_date: '2026-07-01', played_at: 3000, play_count: 1, title: 'Intro', artist: '-' },
  ]);
  assert.equal(ambiguous.length, 3);
});

test('identical ids on different UTC dates remain separate daily counts', () => {
  const rows = mergeTrackRows([
    { play_date: '2026-07-01', played_at: 1000, play_count: 1, title: 'Song', artist: 'Artist', spotify_id: 'spotify-a' },
    { play_date: '2026-07-02', played_at: 2000, play_count: 2, title: 'Song', artist: '-', spotify_id: 'spotify-a' },
  ]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.play_date), ['2026-07-02', '2026-07-01']);
});
