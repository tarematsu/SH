import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../src/rollup-maintenance.js', import.meta.url), 'utf8');

function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0, `${start} section is missing`);
  assert.ok(to > from, `${end} section is missing`);
  return source.slice(from, to);
}

function assertSharedRangeParameters(sql) {
  assert.equal((sql.match(/\?1/g) || []).length, 5);
  assert.equal((sql.match(/\?2/g) || []).length, 5);
  assert.doesNotMatch(sql, /\?(?![12])/);
}

test('daily boundary SQL is built once and reuses two numbered parameters', () => {
  const sql = section('const DAILY_BOUNDARIES_SQL', 'const SUMMARY_BOUNDARIES_SQL');
  assertSharedRangeParameters(sql);
  assert.match(sql, /AS stream_start/);
  assert.match(sql, /AS stream_end/);
  assert.match(sql, /AS member_start/);
  assert.match(sql, /AS member_end/);
  assert.match(sql, /AS primary_host/);

  const daily = section('async function rollupDaily', 'async function rollupFromDaily');
  assert.equal((daily.match(/prepare\(DAILY_BOUNDARIES_SQL\)/g) || []).length, 1);
  assert.match(daily, /\.bind\(period\.start, period\.end\)\.first\(\)/);
  assert.doesNotMatch(daily, /period\.start, period\.end,\s*period\.start/);
});

test('weekly and monthly boundary SQL reuses the same two numbered parameters', () => {
  const sql = section('const SUMMARY_BOUNDARIES_SQL', 'function finite');
  assertSharedRangeParameters(sql);
  assert.match(sql, /AS stream_start/);
  assert.match(sql, /AS stream_end/);
  assert.match(sql, /AS member_start/);
  assert.match(sql, /AS member_end/);
  assert.match(sql, /AS primary_host/);

  const fromDaily = section('async function rollupFromDaily', 'function jstPeriod');
  assert.equal((fromDaily.match(/prepare\(SUMMARY_BOUNDARIES_SQL\)/g) || []).length, 1);
  assert.match(fromDaily, /\.bind\(range\.startKey, range\.endKey\)\.first\(\)/);
  assert.doesNotMatch(fromDaily, /range\.startKey, range\.endKey,\s*range\.startKey/);
});

test('summary upsert consumes one combined boundary row', () => {
  const upsert = section('async function upsertSummary', 'async function rollupDaily');
  assert.match(
    upsert,
    /async function upsertSummary\(db, table, key, aggregate, boundaries, updatedAt\)/,
  );
  assert.match(upsert, /finite\(boundaries\?\.stream_start\)/);
  assert.match(upsert, /finite\(boundaries\?\.stream_end\)/);
  assert.match(upsert, /finite\(boundaries\?\.member_start\)/);
  assert.match(upsert, /finite\(boundaries\?\.member_end\)/);
  assert.match(upsert, /boundaries\?\.primary_host \|\| null/);
  assert.doesNotMatch(upsert, /\bfirst\?\.|\blast\?\.|\bprimaryHost\b/);
});
