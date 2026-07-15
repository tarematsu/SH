import assert from 'node:assert/strict';
import test from 'node:test';

import {
  API_CONTRACT_VERSION,
  API_GROUPS,
  API_SUCCESSORS,
  BLOCKED_API_PATHS,
  COMPATIBILITY_ENDPOINTS,
  INTERNAL_API_PATHS,
  RETIRED_ENDPOINTS,
  canonicalApiPaths,
} from '../functions/lib/api-contract.js';
import { apiCatalog } from '../functions/api/index.js';
import { apiSuccessor, isBlockedApiPath } from '../functions/api/_middleware.js';

function unique(values, label) {
  assert.equal(new Set(values).size, values.length, `${label} must not contain duplicates`);
}

function successorPath(value) {
  return new URL(value, 'https://example.test').pathname;
}

test('API contract classifications are unique and mutually exclusive', () => {
  const canonical = canonicalApiPaths();
  const compatibility = COMPATIBILITY_ENDPOINTS.map(({ path }) => path);
  const retired = RETIRED_ENDPOINTS.map(({ path }) => path);

  unique(canonical, 'canonical API paths');
  unique(compatibility, 'compatibility API paths');
  unique(retired, 'retired API paths');
  unique(INTERNAL_API_PATHS, 'internal API paths');
  unique(BLOCKED_API_PATHS, 'blocked API paths');

  const canonicalSet = new Set(canonical);
  const compatibilitySet = new Set(compatibility);
  for (const path of [...retired, ...INTERNAL_API_PATHS]) {
    assert.equal(canonicalSet.has(path), false, `${path} cannot be canonical`);
    assert.equal(compatibilitySet.has(path), false, `${path} cannot be a compatibility route`);
  }
  for (const path of compatibility) {
    assert.equal(canonicalSet.has(path), false, `${path} cannot be both canonical and compatibility`);
  }
});

test('every compatibility route points to a documented canonical API', () => {
  const canonical = new Set(canonicalApiPaths());
  for (const { path, successor } of COMPATIBILITY_ENDPOINTS) {
    assert.equal(canonical.has(successorPath(successor)), true, `${path} successor must be canonical`);
    assert.equal(API_SUCCESSORS[path], successor);
    assert.equal(apiSuccessor(path), successor);
    assert.equal(apiSuccessor(`${path}/`), successor);
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
  assert.deepEqual(catalog.compatibility, COMPATIBILITY_ENDPOINTS);
  assert.deepEqual(catalog.retired, RETIRED_ENDPOINTS);
  assert.equal(catalog.worker_urls_public, false);
  assert.equal(catalog.public_write_api, false);
});
