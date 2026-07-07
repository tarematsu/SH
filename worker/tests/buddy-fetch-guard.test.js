import assert from 'node:assert/strict';
import test from 'node:test';

import { createBuddyCollectionDependencies } from '../src/buddy-collection-runner.js';
import {
  createBuddyGuardedFetch,
  normalizeBuddyQueuePayload,
  validateBuddyQueuePayload,
} from '../src/buddy-fetch-guard.js';

test('broadcasting payload must include a queue', () => {
  assert.throws(
    () => validateBuddyQueuePayload({
      alias: 'buddy46',
      current_station: { is_broadcasting: true },
    }),
    /broadcasting without a queue/,
  );
});

test('broadcasting payload must include queue tracks', () => {
  assert.throws(
    () => validateBuddyQueuePayload({
      alias: 'buddy46',
      current_station: {
        is_broadcasting: true,
        queue: { id: 99 },
      },
    }),
    /missing queue tracks/,
  );
});

test('off-air payload may omit a queue', () => {
  const payload = {
    alias: 'buddy46',
    current_station: { is_broadcasting: false },
  };
  assert.equal(validateBuddyQueuePayload(payload), payload);
});

test('normalizes wrapped Stationhead channel payloads for collection', () => {
  const normalized = normalizeBuddyQueuePayload({
    data: {
      current_station_id: 46,
      is_broadcasting: true,
      queue: { id: 7, queue_tracks: [] },
    },
  }, 'buddy46');

  assert.equal(normalized.alias, 'buddy46');
  assert.equal(normalized.current_station.id, 46);
  assert.equal(normalized.current_station.queue.id, 7);
  assert.doesNotThrow(() => validateBuddyQueuePayload(normalized, 'buddy46'));
});

test('normalizes wrapped Stationhead api playback payloads for collection', () => {
  const normalized = normalizeBuddyQueuePayload({
    data: {
      playback: {
        handle: 'buddy46',
        station: {
          id: 46,
          is_broadcasting: true,
          queue: { id: 7, queue_tracks: [] },
        },
      },
    },
  }, 'buddy46');

  assert.equal(normalized.alias, 'buddy46');
  assert.equal(normalized.current_station.id, 46);
  assert.equal(normalized.current_station.queue.id, 7);
  assert.doesNotThrow(() => validateBuddyQueuePayload(normalized, 'buddy46'));
});

test('guarded fetch rewrites channel alias reads to the buddy46 handle station endpoint', async () => {
  let seenUrl = null;
  let seenInit = null;
  const guarded = createBuddyGuardedFetch(async (input, init) => {
    seenUrl = new URL(String(input));
    seenInit = init;
    return new Response(JSON.stringify({
      data: {
        current_station_id: 46,
        is_broadcasting: true,
        queue: { id: 7, queue_tracks: [] },
      },
    }), { status: 200 });
  }, 'buddy46');

  const response = await guarded('https://example.invalid/channels/alias/buddy46');
  const body = await response.json();
  assert.equal(seenUrl.pathname, '/station/handle/buddy46/guest');
  assert.equal(seenInit.method, 'POST');
  assert.equal(seenInit.body, '');
  assert.equal(body.alias, 'buddy46');
  assert.equal(body.current_station.queue.id, 7);
});

test('guarded fetch validates api playback reads for buddy46', async () => {
  let seenUrl = null;
  let seenInit = null;
  const guarded = createBuddyGuardedFetch(async (input, init) => {
    seenUrl = new URL(String(input));
    seenInit = init;
    return new Response(JSON.stringify({
      data: {
        playback: {
          handle: 'buddy46',
          station: {
            id: 46,
            is_broadcasting: true,
            queue: { id: 7, queue_tracks: [] },
          },
        },
      },
    }), { status: 200 });
  }, 'buddy46');

  const response = await guarded('https://example.invalid/api/playback?channel=buddy46', { method: 'GET' });
  const body = await response.json();
  assert.equal(seenUrl.pathname, '/api/playback');
  assert.equal(seenUrl.searchParams.get('channel'), 'buddy46');
  assert.equal(seenInit.method, 'GET');
  assert.equal(body.alias, 'buddy46');
  assert.equal(body.current_station.queue.id, 7);
});

test('guarded fetch also validates direct handle station reads', async () => {
  const guarded = createBuddyGuardedFetch(async () => new Response(JSON.stringify({
    data: {
      current_station_id: 46,
      is_broadcasting: true,
      queue: { id: 7, queue_tracks: [] },
    },
  }), { status: 200 }), 'buddy46');

  const response = await guarded('https://example.invalid/station/handle/buddy46/guest');
  const body = await response.json();
  assert.equal(body.alias, 'buddy46');
  assert.equal(body.current_station.queue.id, 7);
});

test('guarded fetch rejects incomplete live payloads', async () => {
  const guarded = createBuddyGuardedFetch(async () => new Response(JSON.stringify({
    alias: 'buddy46',
    current_station: { is_broadcasting: true },
  }), { status: 200 }), 'buddy46');

  await assert.rejects(
    guarded('https://example.invalid/channels/alias/buddy46'),
    /broadcasting without a queue/,
  );
});

test('guarded fetch leaves unrelated requests unchanged', async () => {
  const response = new Response('{}', { status: 200 });
  const guarded = createBuddyGuardedFetch(async () => response, 'buddy46');
  assert.equal(await guarded('https://example.invalid/web/token'), response);
});

test('authentication keeps the original fetch while collection uses the guard', async () => {
  const baseFetch = async () => new Response('{}', { status: 200 });
  let received = null;
  const dependencies = createBuddyCollectionDependencies({}, {
    fetch: baseFetch,
    collect: async (_env, _at, runtimeDependencies) => {
      received = runtimeDependencies;
      return { skipped: false };
    },
  });

  assert.equal(dependencies.fetch, baseFetch);
  await dependencies.collect({}, 123, {});
  assert.notEqual(received.fetch, baseFetch);
});

test('metadata limit zero prevents the external metadata fetch dependency', async () => {
  let externalCalls = 0;
  let received = null;
  const dependencies = createBuddyCollectionDependencies({
    BUDDY_PLAYBACK_METADATA_LIMIT: '0',
  }, {
    collect: async (_env, _at, runtimeDependencies) => {
      received = runtimeDependencies;
      return { skipped: false };
    },
  });

  await dependencies.collect({}, 123, {
    fetchTrackMetadata: async () => {
      externalCalls += 1;
      return { spotify_id: 'unexpected' };
    },
  });
  assert.equal(await received.fetchTrackMetadata({ spotify_id: 'sp1' }), null);
  assert.equal(externalCalls, 0);
});
