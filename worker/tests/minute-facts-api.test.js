import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('minute facts monitoring API is owned only by Pages', () => {
  const config = JSON.parse(readFileSync(new URL('../wrangler.minute.jsonc', import.meta.url), 'utf8'));
  const workerRouter = readFileSync(new URL('../src/minute-production-entry.js', import.meta.url), 'utf8');
  const workerApi = readFileSync(new URL('../src/minute-facts-api.js', import.meta.url), 'utf8');
  const pagesApi = readFileSync(
    new URL('../../site/functions/api/minute-facts/latest.js', import.meta.url),
    'utf8',
  );

  assert.equal(config.main, 'src/minute-entry.js');
  assert.equal(Object.hasOwn(config.vars, 'MINUTE_FACT_API_STALE_MS'), false);
  assert.doesNotMatch(workerRouter, /\/api\/minute-facts\/latest|minute-facts-api\.js/);
  assert.doesNotMatch(workerApi, /SELECT[\s\S]+FROM sh_minute_facts/);
  assert.match(pagesApi, /export async function onRequest/);
  assert.match(pagesApi, /ORDER BY f\.minute_at DESC, f\.id DESC/);
  assert.match(pagesApi, /LIMIT 5/);
});
