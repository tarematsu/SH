import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import buddiesMonitor, { collectRawChannel } from '../src/raw-collector-entry.js';

function session() {
  return {
    authToken: 'token',
    deviceUid: 'device',
    tokenExpiresAt: 9_999_999_999_999,
    collectorUpdatedAt: 1,
  };
}

test('buddies monitor keeps its existing deployment entry', () => {
  const config = JSON.parse(readFileSync(
    new URL('../wrangler.jsonc', import.meta.url),
    'utf8',
  ));

  assert.equal(config.name, 'sh-buddies-monitor');
  assert.equal(config.main, 'src/raw-collector-entry.js');
});

test('scheduled-only production surface registers the collection promise directly', async () => {
  const waited = [];
  const result = buddiesMonitor.scheduled(null, {}, {
    waitUntil(promise) {
      waited.push(promise);
    },
  });

  assert.equal(result, undefined);
  assert.deepEqual(Object.keys(buddiesMonitor), ['scheduled']);
  assert.equal(waited.length, 1);
  await assert.rejects(waited[0], /RAW_COLLECTION_QUEUE binding is missing/);
});

test('production collection skips unrelated ingest configuration work', async () => {
  const sent = [];
  const env = {
    DB: {},
    CHANNEL_ALIAS: 'buddies',
    REQUEST_TIMEOUT_MS: 8_000,
    STATIONHEAD_APP_VERSION: '1.0.0',
    RAW_COLLECTION_QUEUE: {
      async send(message, options) {
        sent.push({ message, options });
      },
    },
  };
  for (const key of [
    'CHAT_LIMIT',
    'COLLECTOR_ID',
    'METADATA_LIMIT',
    'METADATA_REFRESH_INTERVAL_MS',
    '__COLLECTION_ABORT_SIGNAL',
    '__COLLECTION_FETCH_ABORT_SIGNAL',
    '__RAW_CHANNEL_PAYLOAD',
  ]) {
    Object.defineProperty(env, key, {
      get() {
        throw new Error(`unexpected production config read: ${key}`);
      },
    });
  }

  await collectRawChannel(env, {
    ensureSession: async () => session(),
    fetch: async () => new Response('{"id":10}', { status: 200 }),
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].message.message_version, 1);
  assert.equal(sent[0].message.body, '{"id":10}');
  assert.deepEqual(sent[0].options, { contentType: 'json' });
});

test('failed collection rejects before reading the response body', async () => {
  let textCalls = 0;
  let sends = 0;
  await assert.rejects(collectRawChannel({
    DB: {},
    CHANNEL_ALIAS: 'buddies',
    RAW_COLLECTION_QUEUE: {
      async send() { sends += 1; },
    },
  }, {
    ensureSession: async () => session(),
    fetch: async () => ({
      ok: false,
      status: 503,
      headers: { get() { return null; } },
      async text() {
        textCalls += 1;
        return 'unneeded';
      },
    }),
  }), /Stationhead API 503: channel/);

  assert.equal(textCalls, 0);
  assert.equal(sends, 0);
});
