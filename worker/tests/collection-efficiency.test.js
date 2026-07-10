import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCollectionPlan } from '../src/collector-plan.js';
import { internalHealthMonitoringEnabled } from '../src/cadenced-entry.js';
import { shouldRunScheduledMaintenance } from '../src/scheduled-maintenance.js';

test('collection plan disables heartbeat and metadata for an unchanged queue', () => {
  const plan = buildCollectionPlan({
    state: { stationId: 10 },
    queue: { tracks: [{ spotify_id: 'track-1' }] },
    queueResult: { structure_changed: false, likes_changed: true },
  });

  assert.equal(plan.snapshot, true);
  assert.equal(plan.queue, true);
  assert.equal(plan.comments, true);
  assert.equal(plan.metadata, false);
  assert.equal(plan.heartbeat, false);
});

test('collection plan schedules metadata only after a structural queue change', () => {
  const plan = buildCollectionPlan({
    state: { stationId: 10 },
    queue: { tracks: [{ spotify_id: 'track-1' }] },
    queueResult: { structure_changed: true },
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
