import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

import {
  API_CONTRACT_VERSION,
  API_GROUPS,
  canonicalApiPaths,
  materializedResponseCadenceSeconds,
  materializedResponseMaximumAge,
} from '../functions/lib/api-contract.js';
import { apiCatalog } from '../functions/api/index.js';

function unique(values, label) {
  assert.equal(new Set(values).size, values.length, `${label} must not contain duplicates`);
}

test('API contract contains unique canonical paths only', () => {
  const canonical = canonicalApiPaths();
  unique(canonical, 'canonical API paths');
  assert.equal(canonical.length, 9);
  assert.equal(existsSync(new URL('../functions/api/_middleware.js', import.meta.url)), false);
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
  ]) {
    assert.equal(materializedResponseCadenceSeconds(key), 360 * 60, key);
    assert.equal(materializedResponseMaximumAge(key), 365 * minute, key);
  }
  for (const key of ['track-history', 'host-history:summary']) {
    assert.equal(materializedResponseCadenceSeconds(key), 1440 * 60, key);
    assert.equal(materializedResponseMaximumAge(key), 1445 * minute, key);
  }
});

test('cache middleware contains the canonical Sakurazaka policy', () => {
  const source = readFileSync(new URL('../functions/lib/cache-middleware.js', import.meta.url), 'utf8');
  assert.match(source, /\/api\/sakurazaka46jp/);
  assert.match(source, /ttl: 3600/);
});
