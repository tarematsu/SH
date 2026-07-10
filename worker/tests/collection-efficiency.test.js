import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCollectionPlan, metadataRefreshDue } from '../src/collector-plan.js';
import { internalHealthMonitoringEnabled } from '../src/cadenced-entry.js';
import { shouldRunScheduledMaintenance } from '../src/scheduled-maintenance.js';

const SIX_HOURS = 6 * 60 * 60_000;

test('collection plan disables heartbeat and metadata for an unchanged queue within one refresh window', () => {
  const plan = buildCollectionPlan({
    state: { stationId: 10 },
    queue: { tracks: [{ spotify_id: 'track-1' }] },
    queueResult: { structure_changed: false, likes_changed: true },
    previousRunAt: SIX_HOURS + 60_000,
    observedAt: SIX_HOURS + 120_000,
    metadataRefreshIntervalMs: SIX_HOURS,
  });

  assert.equal(plan.snapshot, true);
  assert.equal(plan.queue, true);
  assert.equal(plan.comments, true);
  assert.equal(plan.metadata, false);
  assert.equal(plan.heartbeat, false);
});

test('collection plan schedules metadata after a structural queue change', () => {
  const plan = buildCollectionPlan({
    state: { stationId: 10 },
    queue: { tracks: [{ spotify_id: 'track-1' }] },
    queueResult: { structure_changed: true },
    previousRunAt: SIX_HOURS + 60_000,
    observedAt: SIX_HOURS + 120_000,
  });

  assert.equal(plan.metadata, true);
});

test('collection plan periodically rechecks metadata without a queue change', () => {
  const plan = buildCollectionPlan({
    state: { stationId: 10 },
    queue: { tracks: [{ spotify_id: 'track-1' }] },
    queueResult: { structure_changed: false },
    previousRunAt: SIX_HOURS - 60_000,
    observedAt: SIX_HOURS,
    metadataRefreshIntervalMs: SIX_HOURS,
  });

  assert.equal(metadataRefreshDue(SIX_HOURS - 60_000, SIX_HOURS, SIX_HOURS), true);
  assert.equal(plan.metadata, true);
});

test('collection plan retries metadata after a failed collector cycle', () => {
  const plan = buildCollectionPlan({
    state: { stationId: 10 },
    queue: { tracks: [{ spotify_id: 'track-1' }] },
    queueResult: { structure_changed: false },
    previousRunAt: SIX_HOURS + 60_000,
    observedAt: SIX_HOURS + 120_000,
    metadataRetry: true,
  });

  assert.equal(plan.metadata, true);
});

test('scheduled maintenance is due only on its configured interval boundary', () => {
  assert.equal(shouldRunScheduledMaintenance(3_600_000, {}), true);
  assert.equal(shouldRunScheduledMaintenance(3_660_000, {}), false);
  assert.equal(shouldRunScheduledMaintenance(15 * 60_000, { DATA_MAINTENANCE_INTERVAL_MS: 15 * 60_000 }), true);
});

test('in-process monitoring is opt-in after external monitor migration', () => {
  assert.equal(internalHealthMonitoringEnabled({}), false);
  assert.equal(internalHealthMonitoringEnabled({ STATIONHEAD_INTERNAL_MONITOR_ENABLED: 'true' }), true);
});
