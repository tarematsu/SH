import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';

import { apiCatalog } from '../functions/api/index.js';

function routeCandidates(path) {
  const relative = path.replace(/^\/api\/?/, '');
  if (!relative) return [new URL('../functions/api/index.js', import.meta.url)];
  return [
    new URL(`../functions/api/${relative}.js`, import.meta.url),
    new URL(`../functions/api/${relative}/index.js`, import.meta.url),
  ];
}

function routeExists(path) {
  return routeCandidates(path).some((candidate) => existsSync(candidate));
}

test('documented canonical Pages APIs have Function files', () => {
  const routes = Object.values(apiCatalog(0).groups).flat();
  for (const route of routes) {
    assert.equal(routeExists(route.path), true, `${route.path} must have a Function file`);
  }
});

test('retired APIs are not advertised as active groups', () => {
  const catalog = apiCatalog(0);
  const active = new Set(Object.values(catalog.groups).flat().map(({ path }) => path));
  assert.equal(catalog.public_write_api, false);
  for (const route of catalog.retired) {
    assert.equal(active.has(route.path), false, `${route.path} must not be active`);
    assert.equal(route.status, 404);
  }
});

test('former compatibility route files are physically removed', () => {
  for (const path of [
    '/api/health/collector',
    '/api/history-current',
    '/api/history-migrated',
    '/api/history-raw',
    '/api/official-history',
  ]) {
    assert.equal(routeExists(path), false, `${path} route file must be removed`);
  }
});
