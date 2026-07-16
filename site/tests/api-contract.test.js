import assert from 'node:assert/strict';
import test from 'node:test';

import {
  API_CONTRACT_VERSION,
  API_GROUPS,
  BLOCKED_API_PATHS,
  INTERNAL_API_PATHS,
  RETIRED_ENDPOINTS,
  canonicalApiPaths,
  materializedResponseCadenceSeconds,
  materializedResponseMaximumAge,
} from '../functions/lib/api-contract.js';
import { apiCatalog } from '../functions/api/index.js';
import { isBlockedApiPath } from '../functions/api/_middleware.js';

function unique(values, label) {
  assert.equal(new Set(values).size, values.length, `${label} must not contain duplicates`);
}

test('API contract classifications are unique and mutually exclusive', () => {
  const canonical = canonicalApiPaths();
  const retired = RETIRED_ENDPOINTS.map(({ path }) => path);

  unique(canonical, 'canonical API paths');
  unique(retired, 'retired API paths');
  unique(INTERNAL_API_PATHS, 'internal API paths');
  unique(BLOCKED_API_PATHS, 'blocked API paths');

  const canonicalSet = new Set(canonical);
  for (const path of [...retired, ...INTERNAL_API_PATHS]) {
    assert.equal(canonicalSet.has(path), false, `${path} cannot be canonical`);
  }
});

test('all former compatibility routes are retired with HTTP 404', () => {
  const retired = new Map(RETIRED_ENDPOINTS.map((entry) => [entry.path, entry]));
  for (const path of [
    '/api/health/collector',
    '/api/history-current',
    '/api/history-migrated',
    '/api/history-raw',
    '/api/official-history',
  ]) {
    assert.equal(retired.get(path)?.status, 404, `${path} must be retired`);
    assert.equal(isBlockedApiPath(path), true, path);
    assert.equal(isBlockedApiPath(`${path}/`), true, `${path}/`);
  }
});

test('retired and internal routes are blocked by the middleware contract', () => {
  for (const path of BLOCKED_API_PATHS) {
    assert.equal(isBlockedApiPath(path), true, path);
    assert.equal(isBlockedApiPath(`${path}/`), true, `${path}/`);
  }
  for (const path of canonicalApiPaths()) assert.equal(isBlockedApiPath(path), false, path);
});

test('GET /api catalog is generated from the same contract', () => {
  const catalog = apiCatalog(0);
  assert.equal(catalog.contract_version, API_CONTRACT_VERSION);
  assert.equal(catalog.contract_version >= 2, true);
  assert.deepEqual(catalog.groups, API_GROUPS);
  assert.equal('compatibility' in catalog, false);
  assert.deepEqual(catalog.retired, RETIRED_ENDPOINTS);
  assert.equal(catalog.worker_urls_public, false);
  assert.equal(catalog.public_write_api, false);
});

test('materialized response freshness follows each model cadence', () => {
  const minute = 60_000;
  assert.equal(materializedResponseCadenceSeconds('minute-facts-current'), 5 * 60);
  assert.equal(materializedResponseCadenceSeconds('dashboard-history'), 15 * 60);
  assert.equal(materializedResponseCadenceSeconds('track-likes'), 30 * 60);
  assert.equal(materializedResponseCadenceSeconds('host-history:summary'), 24 * 60 * 60);
  assert.equal(materializedResponseCadenceSeconds('unknown'), 5 * 60);

  assert.equal(materializedResponseMaximumAge('minute-facts-current'), 15 * minute);
  assert.equal(materializedResponseMaximumAge('dashboard-history'), 20 * minute);
  assert.equal(materializedResponseMaximumAge('track-likes'), 35 * minute);
  assert.equal(materializedResponseMaximumAge('host-history:summary'), (24 * 60 + 5) * minute);
  assert.equal(
    materializedResponseMaximumAge('dashboard-history', { PAGES_RESPONSE_MAX_AGE_MS: 15 * minute }),
    20 * minute,
  );
  assert.equal(
    materializedResponseMaximumAge('track-likes', { PAGES_RESPONSE_MAX_AGE_MS: 20 * minute }),
    35 * minute,
  );
  assert.equal(
    materializedResponseMaximumAge('track-likes', { PAGES_RESPONSE_MAX_AGE_MS: 40 * minute }),
    40 * minute,
  );
});
