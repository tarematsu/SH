import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCollectionPlan, metadataRefreshDue } from '../src/collector-plan.js';
import {
  LEGACY_MIGRATION_DISABLED_REASON,
  legacyMigrationEnabled as scheduledLegacyMigrationEnabled,
  minuteFactsCutoverEnabled,
  runScheduledMaintenance,
  shouldRunScheduledMaintenance,
} from '../src/scheduled-maintenance.js';

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
        async all() {
          return { results: [] };
        },
        async run() {
          return { meta: { changes: 1 } };
        },
      };
    },
    async batch(statements) {
      return statements.map(() => ({ success: true }));
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

test('scheduled maintenance is due only on its configured interval boundary', () => {
  assert.equal(shouldRunScheduledMaintenance(3_600_000, {}), true);
  assert.equal(shouldRunScheduledMaintenance(3_660_000, {}), false);
  assert.equal(shouldRunScheduledMaintenance(15 * 60_000, { DATA_MAINTENANCE_INTERVAL_MS: 15 * 60_000 }), true);
});

test('minute facts cutover requires only the MINUTE binding', () => {
  assert.equal(minuteFactsCutoverEnabled({ DB: {} }), false);
  assert.equal(minuteFactsCutoverEnabled({ MINUTE_DB: {} }), true);
  assert.equal(minuteFactsCutoverEnabled({ DB: {}, MINUTE_DB: {} }), true);
});

test('scheduled maintenance legacy migration entry point remains disabled', async () => {
  assert.equal(scheduledLegacyMigrationEnabled(), false);
});

test('scheduled maintenance writes rollups and Pages read models to their owned databases', async () => {
  const sourceSqls = [];
  const minuteSqls = [];
  const result = await runScheduledMaintenance({
    BUDDIES_DB: noSourceDataDb(sourceSqls),
    MINUTE_DB: noSourceDataDb(minuteSqls),
    OTHER_DB: noSourceDataDb(),
  }, 3_600_000);

  assert.equal(result.skipped, false);
  assert.equal(result.reason, 'completed');
  assert.equal(result.rollup.reason, 'no-source-data');
  assert.equal(result.pagesReadModels.skipped, false);
  assert.equal(result.legacyBackfill.reason, LEGACY_MIGRATION_DISABLED_REASON);
  assert.equal(result.minuteFactsBackfill.reason, LEGACY_MIGRATION_DISABLED_REASON);
  assert.equal(sourceSqls.some((sql) => sql.includes('sh_legacy_')), false);
  assert.equal(minuteSqls.some((sql) => sql.includes('sh_pages_payload_read_model')), true);
  assert.equal(minuteSqls.some((sql) => sql.includes('sh_pages_track_history_read_model')), true);
});
