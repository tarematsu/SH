import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function config(name) {
  return JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'));
}

test('current production Workers stay within the account-wide Free cron limit', () => {
  const configs = [
    config('wrangler.minute.jsonc'),
    config('wrangler.other.jsonc'),
    config('wrangler.pages-read-model.jsonc'),
  ];
  const counts = configs.map((value) => value.triggers?.crons?.length || 0);

  assert.deepEqual(counts, [2, 1, 1]);
  assert.equal(counts.reduce((sum, count) => sum + count, 0), 4);
  assert.equal(new Set(configs.map(({ name }) => name)).size, 3);
});

test('consolidated monitor cron is every minute while health tolerates delayed work', () => {
  const other = config('wrangler.other.jsonc');
  assert.deepEqual(other.triggers.crons, ['* * * * *']);
  assert.ok(Number(other.vars.OTHER_CRON_STALE_MS) >= 10 * 60_000);
});
