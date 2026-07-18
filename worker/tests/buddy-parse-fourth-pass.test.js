import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { normalizeBuddyQueuePayload } from '../src/buddy-fetch-guard.js';
import { parseBuddyPlaybackPipelinePayload } from '../src/buddy-playback-pipeline.js';

function track(position) {
  return {
    id: 1_000 + position,
    position,
    track: {
      id: 2_000 + position,
      spotify_id: `spotify-${position}`,
      deezer_id: `deezer-${position}`,
      isrc: `JPTEST${String(position).padStart(4, '0')}`,
      duration_ms: 180_000,
      title: `Track ${position}`,
      artist: { name: `Artist ${position}` },
      album: { name: `Album ${position}`, images: [{ url: `https://img/${position}` }] },
    },
  };
}

test('buddy normalizer reuses the parsed payload and current station objects', () => {
  const station = {
    id: 3858517,
    is_broadcasting: true,
    queue: { id: 3858517, station_id: 3858517, queue_tracks: [] },
  };
  const payload = {
    alias: 'buddies',
    account: { id: 46, handle: 'buddy46' },
    current_station: station,
  };

  const normalized = normalizeBuddyQueuePayload(payload, 'buddy46');

  assert.equal(normalized, payload);
  assert.equal(normalized.current_station, station);
  assert.equal(normalized.alias, 'buddy46');
  assert.equal(normalized.channel_alias, 'buddy46');
  assert.equal(normalized.current_station.broadcast.broadcasters[0].account.handle, 'buddy46');
});

test('buddy pipeline parses a 99-track response with the configured 80-track cap', () => {
  const payload = {
    alias: 'buddies',
    account: { id: 46, handle: 'buddy46' },
    current_station: {
      id: 3858517,
      is_broadcasting: true,
      queue: {
        id: 3858517,
        station_id: 3858517,
        start_time: 1_800_000,
        is_paused: false,
        queue_tracks: Array.from({ length: 99 }, (_value, position) => track(position)),
      },
    },
  };

  const parsed = parseBuddyPlaybackPipelinePayload(JSON.stringify(payload), {
    alias: 'buddy46',
    maxTracks: 80,
  });

  assert.equal(parsed.queue.station_id, 3858517);
  assert.equal(parsed.queue.host_account_id, 46);
  assert.equal(parsed.queue.host_handle, 'buddy46');
  assert.equal(parsed.queue.tracks.length, 80);
  assert.equal(parsed.queue.tracks[0].position, 0);
  assert.equal(parsed.queue.tracks[79].spotify_id, 'spotify-79');
  assert.equal(parsed.queue.tracks[79].thumbnail_url, 'https://img/79');
  assert.deepEqual(JSON.parse(parsed.parsedQueueJson), parsed.queue);
});

test('buddy parse hot path avoids callback extraction and thumbnail candidate arrays', () => {
  const queueSource = readFileSync(new URL('../src/buddy-playback-queue.js', import.meta.url), 'utf8');
  const guardSource = readFileSync(new URL('../src/buddy-fetch-guard.js', import.meta.url), 'utf8');

  assert.doesNotMatch(queueSource, /rawTracks\.slice\([^)]*\)\.map/);
  assert.doesNotMatch(queueSource, /const candidates\s*=\s*\[/);
  assert.doesNotMatch(guardSource, /const candidates\s*=\s*\[/);
  assert.doesNotMatch(guardSource, /\.\.\.\(Array\.isArray\([^)]*broadcasters/);
});
