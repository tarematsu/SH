import assert from 'node:assert/strict';
import test from 'node:test';

import { collectOptionalComments } from '../src/index.js';
import { configFromEnv } from '../src/collector-config.js';

const state = { stationId: 42 };
const config = { chatLimit: 10 };

test('zero CHAT_LIMIT disables optional comment collection', async () => {
  const disabled = configFromEnv({ CHAT_LIMIT: 0 });
  assert.equal(disabled.chatLimit, 0);
  assert.equal(configFromEnv({ CHAT_LIMIT: '0' }).chatLimit, 0);
  assert.equal(configFromEnv({ CHAT_LIMIT: -1 }).chatLimit, 100);
  assert.equal(configFromEnv({ CHAT_LIMIT: 500 }).chatLimit, 100);

  let requests = 0;
  const result = await collectOptionalComments({}, state, disabled, 1_700_000_000_000, {
    requestJson: async () => { requests += 1; return {}; },
    writeIngest: async () => assert.fail('disabled comment collection must not write'),
  });

  assert.deepEqual(result, {
    commentsSaved: 0,
    degraded: false,
    errorStage: null,
  });
  assert.equal(requests, 0);
});

test('comment API failures degrade only optional comment collection', async () => {
  let writes = 0;
  const result = await collectOptionalComments({}, state, config, 1_700_000_000_000, {
    requestJson: async () => { throw new Error('upstream unavailable'); },
    writeIngest: async () => { writes += 1; },
    warn: () => {},
  });

  assert.deepEqual(result, {
    commentsSaved: 0,
    degraded: true,
    errorStage: 'sh_chat_history',
  });
  assert.equal(writes, 0);
});

test('comment ingest failures remain optional after successful fetch', async () => {
  const result = await collectOptionalComments({}, state, config, 1_700_000_000_000, {
    requestJson: async () => ({ chats: [{ id: 7, text: 'hello' }] }),
    writeIngest: async () => { throw new Error('D1 unavailable'); },
    warn: () => {},
  });

  assert.deepEqual(result, {
    commentsSaved: 0,
    degraded: true,
    errorStage: 'd1_write_comments',
  });
});

test('successful optional comment collection reports saved comments', async () => {
  let written = null;
  const result = await collectOptionalComments({}, state, config, 1_700_000_000_000, {
    requestJson: async () => ({ chats: [{ id: 7, text: 'hello' }] }),
    writeIngest: async (_env, type, data, observedAt) => {
      written = { type, data, observedAt };
    },
    warn: () => {},
  });

  assert.equal(result.commentsSaved, 1);
  assert.equal(result.degraded, false);
  assert.equal(result.errorStage, null);
  assert.equal(written.type, 'comments');
  assert.equal(written.data.station_id, 42);
  assert.equal(written.observedAt, 1_700_000_000_000);
});
