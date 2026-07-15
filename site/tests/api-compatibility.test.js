import assert from 'node:assert/strict';
import test from 'node:test';

import { compatibilityRedirect } from '../functions/lib/api-compatibility.js';
import { onRequestGet as collectorHealthAlias } from '../functions/api/health/collector.js';

function assertCompatibilityHeaders(response, successor) {
  assert.equal(response.headers.get('deprecation'), 'true');
  assert.equal(response.headers.get('x-api-successor'), successor);
  assert.equal(response.headers.get('link'), `<${successor}>; rel="successor-version"`);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
}

test('compatibility redirects preserve source query parameters', () => {
  const response = compatibilityRedirect(
    new Request('https://example.com/api/old?from=2026-07-01&limit=50'),
    '/api/new?mode=raw',
  );
  assert.equal(response.status, 308);
  assert.equal(response.headers.get('location'), '/api/new?mode=raw&from=2026-07-01&limit=50');
  assertCompatibilityHeaders(response, '/api/new?mode=raw');
});

test('compatibility redirect target parameters take precedence', () => {
  const response = compatibilityRedirect(
    new Request('https://example.com/api/old?mode=weekly&limit=50'),
    '/api/new?mode=raw',
  );
  assert.equal(response.headers.get('location'), '/api/new?mode=raw&limit=50');
});

test('collector health alias redirects to the canonical Pages health route', async () => {
  const response = await collectorHealthAlias({
    request: new Request('https://example.com/api/health/collector?probe=1'),
  });
  assert.equal(response.status, 308);
  assert.equal(response.headers.get('location'), '/api/health?probe=1');
  assertCompatibilityHeaders(response, '/api/health');
});
