import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../src/rollup-maintenance.js', import.meta.url), 'utf8');

test('rollups reject total-listener values masquerading as total streams', () => {
  assert.match(source, /validated_stream_count IS NOT total_listens/);
  assert.match(source, /current_stream_count IS NOT total_listens/);
  assert.match(source, /COALESCE\([\s\S]*validated_stream_count[\s\S]*current_stream_count/);
});

test('July contaminated summaries are rebuilt once from daily source data', () => {
  assert.match(source, /'2026-07-11', '2026-07-12', '2026-07-13'/);
  assert.match(source, /rollup-stream-repair-2026-07/);
  assert.match(source, /rollupDaily\(db, otherDb, jstPeriod\(key\), now\)/);
  assert.match(source, /rollupFromDaily\(otherDb, 'sh_weekly_summary'/);
  assert.match(source, /rollupFromDaily\(otherDb, 'sh_monthly_summary'/);
});
