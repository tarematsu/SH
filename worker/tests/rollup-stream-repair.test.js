import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../src/rollup-maintenance.js', import.meta.url), 'utf8');

test('rollups reject total-listener values masquerading as total streams', () => {
  assert.match(source, /validated_stream_count IS NOT total_listens/);
  assert.match(source, /current_stream_count IS NOT total_listens/);
  assert.match(source, /COALESCE\([\s\S]*validated_stream_count[\s\S]*current_stream_count/);
});

test('July contaminated summaries are retried from corrected daily source data', () => {
  assert.match(source, /'2026-07-11', '2026-07-12', '2026-07-13'/);
  assert.match(source, /rollup-stream-repair-2026-07-v2/);
  assert.match(source, /rollupDaily\(db, otherDb, jstPeriod\(key\), now\)/);
  assert.match(source, /rollupFromDaily\(otherDb, 'sh_weekly_summary'/);
  assert.match(source, /rollupFromDaily\(otherDb, 'sh_monthly_summary'/);
});

test('repair is marked complete only after every weekly and monthly write succeeds', () => {
  assert.match(source, /repairedWeeks\.length !== weeks\.size/);
  assert.match(source, /repairedMonths\.length !== months\.size/);
  assert.match(source, /repair-summary-write-incomplete/);
  const incompleteCheck = source.indexOf("reason: 'repair-summary-write-incomplete'");
  const stateWrite = source.indexOf('INSERT INTO sh_data_maintenance_state', incompleteCheck);
  assert.ok(incompleteCheck >= 0);
  assert.ok(stateWrite > incompleteCheck);
});
