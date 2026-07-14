import assert from 'node:assert/strict';
import test from 'node:test';

import { supportsOptimizedIngestType } from '../../site/functions/api/ingest.js';
import { ingest } from '../src/collector-ingest.js';

test('all collector write types use the optimized direct ingest path', () => {
  assert.equal(supportsOptimizedIngestType('snapshot'), true);
  assert.equal(supportsOptimizedIngestType('queue'), true);
  assert.equal(supportsOptimizedIngestType('comments'), true);
  assert.equal(supportsOptimizedIngestType('collector_heartbeat'), true);
  assert.equal(supportsOptimizedIngestType('track_metadata'), true);
});

test('track metadata is written directly without constructing an internal HTTP Request', async () => {
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
  const statements = [];
  const db = {
    prepare(sql) {
      const statement = {
        sql,
        params: [],
        bind(...params) { this.params = params; return this; },
      };
      statements.push(statement);
      return statement;
    },
    async batch(batch) { assert.deepEqual(batch, statements); },
  };

  try {
    const result = await ingest({ DB: db }, 'track_metadata', {
      tracks: [{ spotify_id: 'track-1', title: 'Song', artist: 'Artist' }],
    }, 123_000, { returnDetails: true });
    assert.equal(requestConstructed, false);
    assert.equal(statements.length, 1);
    assert.match(statements[0].sql, /INSERT INTO sh_track_metadata/);
    assert.deepEqual(result, {
      ok: true,
      type: 'track_metadata',
      accepted: true,
      tracks_written: 1,
    });
  } finally {
    Object.defineProperty(globalThis, 'Request', {
      configurable: true,
      writable: true,
      value: originalRequest,
    });
  }
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
