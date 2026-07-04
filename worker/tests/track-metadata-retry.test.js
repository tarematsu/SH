import test from 'node:test';
import assert from 'node:assert/strict';

import { metadataNeedsRefresh } from '../src/shared.js';

const DAY_MS = 24 * 60 * 60 * 1000;

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
