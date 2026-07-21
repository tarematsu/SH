import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCollectionPlan, metadataRefreshDue } from '../src/collector-plan.js';

const FIFTEEN_MINUTES = 15 * 60_000;

test('collection plan disables heartbeat and metadata for an unchanged queue within one refresh window', () => {
  const plan = buildCollectionPlan({
    state: { stationId: 10 },
    queue: { tracks: [{ spotify_id: 'track-1' }] },
    queueResult: { structure_changed: false, likes_changed: true },
    previousRunAt: FIFTEEN_MINUTES + 60_000,
    observedAt: FIFTEEN_MINUTES + 120_000,
    metadataRefreshIntervalMs: FIFTEEN_MINUTES,
  });

  assert.equal(plan.snapshot, true);
  assert.equal(plan.queue, true);
  assert.equal(plan.comments, true);
  assert.equal(plan.metadata, false);
  assert.equal(plan.metadataDue, false);
  assert.equal(plan.heartbeat, false);
});

test('collection plan schedules metadata after a structural queue change', () => {
  const plan = buildCollectionPlan({
    state: { stationId: 10 },
    queue: { tracks: [{ spotify_id: 'track-1' }] },
    queueResult: { structure_changed: true },
    previousRunAt: FIFTEEN_MINUTES + 60_000,
    observedAt: FIFTEEN_MINUTES + 120_000,
  });

  assert.equal(plan.metadata, true);
});

test('collection plan periodically rechecks metadata after fifteen minutes without a queue change', () => {
  const plan = buildCollectionPlan({
    state: { stationId: 10 },
    queue: { tracks: [{ spotify_id: 'track-1' }] },
    queueResult: { structure_changed: false },
    previousRunAt: FIFTEEN_MINUTES - 60_000,
    observedAt: FIFTEEN_MINUTES,
    metadataRefreshIntervalMs: FIFTEEN_MINUTES,
  });

  assert.equal(metadataRefreshDue(
    FIFTEEN_MINUTES - 60_000,
    FIFTEEN_MINUTES,
    FIFTEEN_MINUTES,
  ), true);
  assert.equal(plan.metadata, true);
});

test('collection plan retries metadata after a failed collector cycle', () => {
  const plan = buildCollectionPlan({
    state: { stationId: 10 },
    queue: { tracks: [{ spotify_id: 'track-1' }] },
    queueResult: { structure_changed: false },
    previousRunAt: FIFTEEN_MINUTES + 60_000,
    observedAt: FIFTEEN_MINUTES + 120_000,
    metadataRetry: true,
  });

  assert.equal(plan.metadata, true);
});
