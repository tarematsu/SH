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
  const catalog = apiCatalog(0);
  const routes = Object.values(catalog.groups).flat();
  assert.equal(catalog.contract_version, 3);
  assert.equal('retired' in catalog, false);
  for (const route of routes) {
    assert.equal(routeExists(route.path), true, `${route.path} must have a Function file`);
  }
});

test('removed public API files remain physically absent', () => {
  for (const path of [
    '/api/health/collector',
    '/api/history-current',
    '/api/history-migrated',
    '/api/history-raw',
    '/api/official-history',
    '/api/playback',
    '/api/dashboard-history',
    '/api/dashboard-queue',
    '/api/dashboard-recovery',
    '/api/minute-facts',
    '/api/minute-facts/current',
    '/api/minute-facts/latest',
    '/api/comment-velocity',
    '/api/track-likes',
    '/api/like-ranking',
    '/api/broadcast-series',
  ]) {
    assert.equal(routeExists(path), false, `${path} route file must be removed`);
  }
});
