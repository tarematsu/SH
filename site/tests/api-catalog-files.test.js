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

test('retired APIs are neither active nor implemented as route files', () => {
  const catalog = apiCatalog(0);
  const active = new Set(Object.values(catalog.groups).flat().map(({ path }) => path));
  assert.equal(catalog.public_write_api, false);
  for (const route of catalog.retired) {
    assert.equal(active.has(route.path), false, `${route.path} must not be active`);
    assert.equal(route.status, 404);
    assert.equal(routeExists(route.path), false, `${route.path} route file must be removed`);
  }
});
