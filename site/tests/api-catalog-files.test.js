import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';

import { apiCatalog } from '../functions/api/index.js';

function routeFile(path) {
  const relative = path.replace(/^\/api\/?/, '');
  return relative
    ? new URL(`../functions/api/${relative}.js`, import.meta.url)
    : new URL('../functions/api/index.js', import.meta.url);
}

test('documented Pages API routes have Function files', () => {
  const routes = Object.values(apiCatalog(0).groups).flat();
  for (const route of routes) {
    if (route.path === '/api/history') continue;
    assert.equal(existsSync(routeFile(route.path)), true, `${route.path} must have a Function file`);
  }
});
