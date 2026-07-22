import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { apiCatalog } from '../functions/api/index.js';

const apiRoot = fileURLToPath(new URL('../functions/api/', import.meta.url));

function routeCandidates(routePath) {
  const relative = routePath.replace(/^\/api\/?/, '');
  if (!relative) return [new URL('../functions/api/index.js', import.meta.url)];
  return [
    new URL(`../functions/api/${relative}.js`, import.meta.url),
    new URL(`../functions/api/${relative}.mjs`, import.meta.url),
    new URL(`../functions/api/${relative}/index.js`, import.meta.url),
    new URL(`../functions/api/${relative}/index.mjs`, import.meta.url),
  ];
}

function routeExists(routePath) {
  return routeCandidates(routePath).some((candidate) => existsSync(candidate));
}

function sourceFiles(directory = apiRoot) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(absolute);
    return /\.(?:m?js)$/.test(entry.name) ? [absolute] : [];
  });
}

function routeForFile(absolute) {
  const relative = path.relative(apiRoot, absolute).replaceAll(path.sep, '/');
  const withoutExtension = relative.replace(/\.(?:m?js)$/, '');
  const route = withoutExtension === 'index'
    ? ''
    : withoutExtension.endsWith('/index')
      ? withoutExtension.slice(0, -'/index'.length)
      : withoutExtension;
  return `/api${route ? `/${route}` : ''}`;
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

test('Pages API directory contains only declared JavaScript routes', () => {
  const catalog = apiCatalog(0);
  const canonical = Object.values(catalog.groups).flat().map(({ path: routePath }) => routePath);
  const expected = new Set(['/api', ...canonical]);
  const actual = sourceFiles().map(routeForFile).sort();

  assert.equal(new Set(actual).size, actual.length, 'Pages API routes must not have duplicate files');
  assert.deepEqual(actual, [...expected].sort());
});
