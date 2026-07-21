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

test('every documented canonical Pages API has exactly one Function route', () => {
  const catalog = apiCatalog(0);
  const routes = Object.values(catalog.groups).flat();
  assert.equal(catalog.contract_version, 3);
  assert.equal('retired' in catalog, false);
  for (const route of routes) {
    const matches = routeCandidates(route.path).filter((candidate) => existsSync(candidate));
    assert.equal(matches.length, 1, `${route.path} must have exactly one Function file`);
    assert.equal(routeExists(route.path), true, `${route.path} must be routable`);
  }
});
