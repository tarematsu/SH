import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  CONSOLIDATED_MONITOR_CRON,
  otherMonitorDue,
  rawCollectorEnv,
} from '../src/consolidated-monitor-entry.js';
import { collectRawChannel } from '../src/raw-collector-entry.js';

function session() {
  return {
    authToken: 'token',
    deviceUid: 'device',
    tokenExpiresAt: 9_999_999_999_999,
    collectorUpdatedAt: 1,
  };
}

test('buddies collection is deployed through the consolidated monitor Worker', () => {
  const config = JSON.parse(readFileSync(
    new URL('../wrangler.other.jsonc', import.meta.url),
    'utf8',
  ));

  assert.equal(config.name, 'sh-monitor-other');
  assert.equal(config.main, 'src/other-entry.js');
  assert.deepEqual(config.triggers.crons, [CONSOLIDATED_MONITOR_CRON]);
  assert.equal(
    config.queues.producers.some(({ binding }) => binding === 'RAW_COLLECTION_QUEUE'),
    true,
  );
});

test('the consolidated schedule runs other monitoring every five minutes', () => {
  assert.equal(otherMonitorDue(Date.UTC(2026, 0, 1, 0, 0)), true);
  assert.equal(otherMonitorDue(Date.UTC(2026, 0, 1, 0, 1)), false);
  assert.equal(otherMonitorDue(Date.UTC(2026, 0, 1, 0, 5)), true);
});

test('the consolidated collector aliases BUDDIES_DB to the legacy DB binding', () => {
  const BUDDIES_DB = {};
  const active = rawCollectorEnv({ BUDDIES_DB });
  assert.equal(active.DB, BUDDIES_DB);
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
