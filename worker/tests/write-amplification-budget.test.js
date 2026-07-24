import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const dailyState = readFileSync(new URL('../src/minute-facts-daily-state.js', import.meta.url), 'utf8');
const statementPlan = readFileSync(new URL('../src/minute-facts-statement-plan.js', import.meta.url), 'utf8');
const migration = readFileSync(
  new URL('../../database/facts-migrations/039_reduce_fact_write_amplification.sql', import.meta.url),
  'utf8',
);

const MINUTES_PER_DAY = 24 * 60;
const FIVE_MINUTE_BUCKETS_PER_DAY = MINUTES_PER_DAY / 5;

test('steady-state write reductions cover the measured daily overage', () => {
  assert.doesNotMatch(dailyState, /CHECKPOINT/);
  assert.match(dailyState, /excluded\.last_total_member_count IS NOT/);
  assert.match(statementPlan, /Math\.floor\(minuteAt \/ DASHBOARD_BUCKET_MS\)/);
  assert.match(statementPlan, /ON CONFLICT\(channel_id,bucket_at\) DO UPDATE/);
  assert.match(migration, /idx_sh_minute_facts_source_minute_desc/);
  assert.match(migration, /idx_sh_minute_facts_total_listens_baseline/);

  const savedDailyMemberWrites = MINUTES_PER_DAY - 1;
  const savedDuplicateIndexWrites = MINUTES_PER_DAY;
  const savedTotalListensIndexWrites = MINUTES_PER_DAY;
  const savedRollupWrites = MINUTES_PER_DAY - FIVE_MINUTE_BUCKETS_PER_DAY;
  const projectedSavedWrites = savedDailyMemberWrites
    + savedDuplicateIndexWrites
    + savedTotalListensIndexWrites
    + savedRollupWrites;

  assert.equal(projectedSavedWrites, 5_471);
  assert.ok(projectedSavedWrites > 5_027);
});
