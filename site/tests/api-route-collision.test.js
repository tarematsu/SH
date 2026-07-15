import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

test('Pages health file and directory do not define the same route', () => {
  assert.equal(existsSync(new URL('../functions/api/health.js', import.meta.url)), true);
  assert.equal(existsSync(new URL('../functions/api/health/index.js', import.meta.url)), false);
});

test('Pages Functions include the exact API catalog and API subtree only', () => {
  const routes = JSON.parse(readFileSync(new URL('../public/_routes.json', import.meta.url), 'utf8'));
  assert.equal(routes.version, 1);
  assert.deepEqual(routes.include, ['/api', '/api/*']);
  assert.deepEqual(routes.exclude, []);

  for (const staticPath of ['/', '/history/', '/index.html', '/styles.css']) {
    assert.equal(routes.include.includes(staticPath), false, `${staticPath} must remain a static Pages asset`);
  }
});
