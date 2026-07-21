import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  API_CONTRACT_VERSION,
  API_GROUPS,
  INTERNAL_API_PATHS,
  canonicalApiPaths,
  materializedResponseCadenceSeconds,
  materializedResponseMaximumAge,
} from '../functions/lib/api-contract.js';
import { apiCatalog } from '../functions/api/index.js';
import { isBlockedApiPath } from '../functions/api/_middleware.js';

function unique(values, label) {
  assert.equal(new Set(values).size, values.length, `${label} must not contain duplicates`);
}

test('API contract contains unique canonical and internal paths', () => {
  const canonical = canonicalApiPaths();
  unique(canonical, 'canonical API paths');
  unique(INTERNAL_API_PATHS, 'internal API paths');
  const canonicalSet = new Set(canonical);
  for (const path of INTERNAL_API_PATHS) assert.equal(canonicalSet.has(path), false, `${path} cannot be canonical`);
});

test('middleware blocks internal routes but not canonical APIs', () => {
  for (const path of INTERNAL_API_PATHS) {
    assert.equal(isBlockedApiPath(path), true, path);
    assert.equal(isBlockedApiPath(`${path}/`), true, `${path}/`);
  }
  for (const path of canonicalApiPaths()) assert.equal(isBlockedApiPath(path), false, path);
});

test('GET /api catalog is generated from the canonical contract only', () => {
  const catalog = apiCatalog(0);
  assert.equal(catalog.contract_version, API_CONTRACT_VERSION);
  assert.equal(catalog.contract_version, 3);
  assert.deepEqual(catalog.groups, API_GROUPS);
  assert.equal('compatibility' in catalog, false);
  assert.equal('retired' in catalog, false);
  assert.equal(catalog.worker_urls_public, false);
  assert.equal(catalog.public_write_api, false);
});

test('materialized response freshness follows canonical generation cadences', () => {
  const minute = 60_000;
  for (const key of [
    'history:daily',
    'history:weekly',
    'history:monthly',
    'history:broadcasts',
    'track-history',
  ]) {
    assert.equal(materializedResponseCadenceSeconds(key), 360 * 60, key);
    assert.equal(materializedResponseMaximumAge(key), 365 * minute, key);
  }
  assert.equal(materializedResponseCadenceSeconds('host-history:summary'), 1440 * 60);
  assert.equal(materializedResponseMaximumAge('host-history:summary'), 1445 * minute);
});

test('cache middleware contains the canonical Sakurazaka policy', () => {
  const source = readFileSync(new URL('../functions/lib/cache-middleware.js', import.meta.url), 'utf8');
  assert.match(source, /\/api\/sakurazaka46jp/);
  assert.match(source, /ttl: 3600/);
});
