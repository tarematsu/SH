import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function config(name) {
  return JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'));
}

test('three production Workers stay within the account-wide Free cron limit', () => {
  const configs = [
    config('wrangler.jsonc'),
    config('wrangler.minute.jsonc'),
    config('wrangler.other.jsonc'),
  ];
  const counts = configs.map((value) => value.triggers?.crons?.length || 0);

  assert.deepEqual(counts, [1, 3, 1]);
  assert.equal(counts.reduce((sum, count) => sum + count, 0), 5);
});

test('other cron health threshold tolerates a delayed five-minute tick', () => {
  const other = config('wrangler.other.jsonc');
  assert.deepEqual(other.triggers.crons, ['*/5 * * * *']);
  assert.ok(Number(other.vars.OTHER_CRON_STALE_MS) >= 10 * 60_000);
});
