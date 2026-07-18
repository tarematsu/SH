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

test('daily rollup loads stream, member, and host boundaries in one D1 query', () => {
  const daily = section('async function rollupDaily', 'async function rollupFromDaily');
  assert.equal((daily.match(/const boundaries = await db\.prepare/g) || []).length, 1);
  assert.doesNotMatch(daily, /const (?:first|last|host) = await db\.prepare/);
  assert.match(daily, /AS stream_start/);
  assert.match(daily, /AS stream_end/);
  assert.match(daily, /AS member_start/);
  assert.match(daily, /AS member_end/);
  assert.match(daily, /AS primary_host/);
  assert.match(daily, /boundaries\?\.primary_host/);
});

test('weekly and monthly rollups reuse one combined daily-summary boundary query', () => {
  const fromDaily = section('async function rollupFromDaily', 'function jstPeriod');
  assert.equal((fromDaily.match(/const boundaries = await otherDb\.prepare/g) || []).length, 1);
  assert.doesNotMatch(fromDaily, /const (?:first|last|host) = await otherDb\.prepare/);
  assert.match(fromDaily, /AS stream_start/);
  assert.match(fromDaily, /AS stream_end/);
  assert.match(fromDaily, /AS member_start/);
  assert.match(fromDaily, /AS member_end/);
  assert.match(fromDaily, /AS primary_host/);
  assert.match(fromDaily, /boundaries\?\.primary_host/);
});
