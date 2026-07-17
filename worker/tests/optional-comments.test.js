import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { normalizeCommentCountInputs } from '../src/collector-comments.js';
import { collectOptionalComments } from '../src/index.js';
import { configFromEnv } from '../src/collector-config.js';

const state = { stationId: 42 };
const config = { chatLimit: 10 };

function workerConfig(name) {
  return JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'));
}

test('zero CHAT_LIMIT disables optional comment collection', async () => {
  const disabled = configFromEnv({ CHAT_LIMIT: 0 });
  assert.equal(disabled.chatLimit, 0);
  assert.equal(configFromEnv({ CHAT_LIMIT: '0' }).chatLimit, 0);
  assert.equal(configFromEnv({ CHAT_LIMIT: '' }).chatLimit, 100);
  assert.equal(configFromEnv({ CHAT_LIMIT: '   ' }).chatLimit, 100);
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

test('deployed split configs disable ingest comments and keep comments Worker collection enabled', () => {
  const ingest = workerConfig('wrangler.ingest.jsonc');
  const comments = workerConfig('wrangler.comments.jsonc');

  assert.equal(ingest.name, 'sh-ingest-channel');
  assert.equal(configFromEnv(ingest.vars).chatLimit, 0);
  assert.equal(comments.name, 'sh-comments');
  assert.equal(configFromEnv(comments.vars).chatLimit, 50);
});

test('comment count inputs retain only identity and timestamp fields', () => {
  const comments = normalizeCommentCountInputs({
    chats: {
      items: [
        {
          id: '7',
          station_id: '42',
          chat_time: '100',
          text: 'unused',
          account: { handle: 'unused', followers: 10 },
        },
        { comment_id: 7, chat_time_ms: 200, text: 'duplicate' },
        { id: 'opaque', chat_time_ms: '300', raw: { unused: true } },
        { id: 'opaque', chat_time_ms: 400 },
        { id: '   ', chat_time_ms: 500 },
      ],
    },
  }, 42);

  assert.deepEqual(comments, [
    {
      comment_id: 7,
      id: '7',
      station_id: 42,
      chat_time: 100,
      chat_time_ms: null,
    },
    {
      comment_id: null,
      id: 'opaque',
      station_id: 42,
      chat_time: null,
      chat_time_ms: 300,
    },
  ]);
  assert.equal(Object.hasOwn(comments[0], 'text'), false);
  assert.equal(Object.hasOwn(comments[0], 'raw'), false);
  assert.equal(Object.hasOwn(comments[0], 'account_id'), false);
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
  assert.deepEqual(written.data.comments, [{
    comment_id: 7,
    id: 7,
    station_id: 42,
    chat_time: null,
    chat_time_ms: null,
  }]);
  assert.equal(written.observedAt, 1_700_000_000_000);
});
