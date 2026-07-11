import assert from 'node:assert/strict';
import test from 'node:test';

import { supportsOptimizedIngestType } from '../../site/functions/api/ingest.js';
import { ingest } from '../src/collector-ingest.js';

test('snapshot and queue use the optimized direct ingest path', () => {
  assert.equal(supportsOptimizedIngestType('snapshot'), true);
  assert.equal(supportsOptimizedIngestType('queue'), true);
  assert.equal(supportsOptimizedIngestType('track_metadata'), false);
});

test('supported collector ingest does not construct an internal HTTP Request', async () => {
  const originalRequest = globalThis.Request;
  let requestConstructed = false;
  Object.defineProperty(globalThis, 'Request', {
    configurable: true,
    writable: true,
    value: class ForbiddenRequest {
      constructor() {
        requestConstructed = true;
        throw new Error('internal Request should not be constructed');
      }
    },
  });

  const calls = [];
  const db = {
    prepare(sql) {
      return {
        bind(...params) {
          calls.push({ sql, params });
          return this;
        },
        async run() {
          return { meta: { changes: 1 } };
        },
      };
    },
  };

  try {
    const result = await ingest(
      { DB: db, COLLECTOR_ID: 'test-collector' },
      'collector_heartbeat',
      { collector_id: 'test-collector', version: '1' },
      123_000,
      { returnDetails: true },
    );

    assert.equal(requestConstructed, false);
    assert.equal(calls.length, 1);
    assert.deepEqual(result, {
      ok: true,
      type: 'collector_heartbeat',
      accepted: true,
    });
  } finally {
    Object.defineProperty(globalThis, 'Request', {
      configurable: true,
      writable: true,
      value: originalRequest,
    });
  }
});
