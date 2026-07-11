import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCollectionPlan, metadataRefreshDue } from '../src/collector-plan.js';
import { internalHealthMonitoringEnabled } from '../src/cadenced-entry.js';
import {
  LEGACY_MIGRATION_DISABLED_REASON,
  legacyMigrationEnabled as scheduledLegacyMigrationEnabled,
  minuteFactsCutoverEnabled,
  runScheduledMaintenance,
  shouldRunScheduledMaintenance,
} from '../src/scheduled-maintenance.js';
import {
  legacyMigrationEnabled as minuteFactsLegacyMigrationEnabled,
  runMinuteFactsBackfill,
} from '../src/minute-facts-backfill.js';

const FIFTEEN_MINUTES = 15 * 60_000;

function noSourceDataDb(sqls = []) {
  return {
    prepare(sql) {
      sqls.push(sql);
      return {
        bind() {
          return this;
        },
        async first() {
          if (sql.includes('SELECT last_rollup_key')) return { last_rollup_key: null };
          if (sql.includes('COUNT(*) AS sample_count')) return { sample_count: 0 };
          return null;
        },
        async run() {
          return { meta: { changes: 1 } };
        },
      };
    },
  };
}

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

test('scheduled maintenance is due only on its configured interval boundary', () => {
  assert.equal(shouldRunScheduledMaintenance(3_600_000, {}), true);
  assert.equal(shouldRunScheduledMaintenance(3_660_000, {}), false);
  assert.equal(shouldRunScheduledMaintenance(15 * 60_000, { DATA_MAINTENANCE_INTERVAL_MS: 15 * 60_000 }), true);
});

test('minute facts cutover detection remains compatible with both D1 bindings', () => {
  assert.equal(minuteFactsCutoverEnabled({ DB: {} }), false);
  assert.equal(minuteFactsCutoverEnabled({ FACTS_DB: {} }), false);
  assert.equal(minuteFactsCutoverEnabled({ DB: {}, FACTS_DB: {} }), true);
});

test('all legacy migration entry points are disabled', async () => {
  assert.equal(scheduledLegacyMigrationEnabled(), false);
  assert.equal(minuteFactsLegacyMigrationEnabled(), false);
  assert.deepEqual(await runMinuteFactsBackfill({ DB: {}, FACTS_DB: {} }), {
    skipped: true,
    reason: LEGACY_MIGRATION_DISABLED_REASON,
    migrated: 0,
  });
});

test('scheduled maintenance runs rollups without touching legacy or facts migration tables', async () => {
  const sqls = [];
  const result = await runScheduledMaintenance({
    DB: noSourceDataDb(sqls),
    FACTS_DB: new Proxy({}, {
      get() {
        throw new Error('FACTS_DB must not be touched by scheduled maintenance');
      },
    }),
  }, 3_600_000);

  assert.equal(result.skipped, false);
  assert.equal(result.legacyBackfill.reason, LEGACY_MIGRATION_DISABLED_REASON);
  assert.equal(result.minuteFactsBackfill.reason, LEGACY_MIGRATION_DISABLED_REASON);
  assert.equal(sqls.some((sql) => sql.includes('sh_legacy_')), false);
});

test('in-process monitoring is opt-in after external monitor migration', () => {
  assert.equal(internalHealthMonitoringEnabled({}), false);
  assert.equal(internalHealthMonitoringEnabled({ STATIONHEAD_INTERNAL_MONITOR_ENABLED: 'true' }), true);
});
