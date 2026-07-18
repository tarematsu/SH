import assert from 'node:assert/strict';
import test from 'node:test';

import { processBuddyPlaybackStage } from '../src/buddy-playback-entry.js';
import {
  BUDDY_PARSE_COMPUTE_STAGE,
  BUDDY_PARSE_STORE_STAGE,
  processBuddyParseCompute,
  processBuddyParseStore,
} from '../src/buddy-playback-parse-stages.js';

function rawPayload() {
  return JSON.stringify({
    alias: 'buddies',
    account: { id: 46, handle: 'buddy46' },
    current_station: {
      id: 3858517,
      is_broadcasting: true,
      queue: {
        id: 77,
        station_id: 3858517,
        start_time: 1_800_000,
        is_paused: false,
        queue_tracks: [],
      },
    },
  });
}

function baseBody(overrides = {}) {
  return {
    message_type: 'buddy-playback-stage',
    message_version: 1,
    scheduled_at: 1_800_000,
    observed_at: 1_800_123,
    channel_alias: 'buddy46',
    cycle_at: 1_800_000,
    ...overrides,
  };
}

test('normal fetch completion routes the next message to direct parse compute', async () => {
  const sent = [];
  const result = await processBuddyPlaybackStage({
    BUDDY_PLAYBACK_ENABLED: true,
    BUDDY_PLAYBACK_QUEUE: {
      async send(body, options) { sent.push({ body, options }); },
    },
  }, baseBody(), {
    advance: async () => ({
      skipped: false,
      pending: true,
      stage: 'parse',
      cycle_at: 1_800_000,
    }),
  });

  assert.equal(result.requeued, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.direct_stage, BUDDY_PARSE_COMPUTE_STAGE);
  assert.equal(sent[0].body.expected_stage, undefined);
  assert.equal(sent[0].body.channel_alias, 'buddy46');
});

test('direct parse compute reads one durable row and emits compact parse-store work', async () => {
  let firstCalls = 0;
  const env = {
    BUDDY_PLAYBACK_ENABLED: true,
    OTHER_DB: {
      prepare(sql) {
        assert.match(sql, /FROM sh_buddy_playback_pipeline/);
        return {
          bind(alias) {
            assert.equal(alias, 'buddy46');
            return this;
          },
          async first() {
            firstCalls += 1;
            return {
              channel_alias: 'buddy46',
              cycle_at: 1_800_000,
              observed_at: 1_800_123,
              stage: 'parse',
              raw_json: rawPayload(),
            };
          },
        };
      },
    },
  };

  const result = await processBuddyParseCompute(env, {
    channelAlias: 'buddy46',
    cycleAt: 1_800_000,
  });

  assert.equal(firstCalls, 1);
  assert.equal(result.pending, true);
  assert.equal(result.stage, BUDDY_PARSE_STORE_STAGE);
  assert.equal(result.direct_stage, BUDDY_PARSE_STORE_STAGE);
  assert.equal(result.prepared_parse.queue.station_id, 3858517);
  assert.deepEqual(result.prepared_parse.queue.tracks, []);
});

test('direct parse-store replay re-emits metadata handoff after an earlier durable update', async () => {
  const statements = [];
  const env = {
    OTHER_DB: {
      prepare(sql) {
        statements.push(sql);
        if (sql.startsWith('UPDATE')) {
          return {
            bind() { return this; },
            async run() { return { meta: { changes: 0 } }; },
          };
        }
        return {
          bind(alias) {
            assert.equal(alias, 'buddy46');
            return this;
          },
          async first() {
            return {
              channel_alias: 'buddy46',
              cycle_at: 1_800_000,
              stage: 'metadata',
            };
          },
        };
      },
    },
  };
  const result = await processBuddyParseStore(env, {
    channelAlias: 'buddy46',
    cycleAt: 1_800_000,
    observedAt: 1_800_456,
    preparedParse: {
      channel_alias: 'buddy46',
      cycle_at: 1_800_000,
      observed_at: 1_800_123,
      queue: {
        station_id: 3858517,
        queue_id: 77,
        start_time: 1_800_000,
        is_paused: false,
        is_broadcasting: true,
        host_account_id: 46,
        host_handle: 'buddy46',
        tracks: [],
      },
    },
  });

  assert.equal(result.pending, true);
  assert.equal(result.stage, 'metadata');
  assert.equal(result.replayed_handoff, true);
  assert.equal(statements.length, 2);
});

test('direct parse-store success persists once and advances to metadata', async () => {
  let runCalls = 0;
  const env = {
    OTHER_DB: {
      prepare(sql) {
        assert.match(sql, /^UPDATE sh_buddy_playback_pipeline/);
        return {
          bind(...values) {
            assert.equal(values.at(-2), 'buddy46');
            assert.equal(values.at(-1), 1_800_000);
            return this;
          },
          async run() {
            runCalls += 1;
            return { meta: { changes: 1 } };
          },
        };
      },
    },
  };
  const result = await processBuddyParseStore(env, {
    channelAlias: 'buddy46',
    cycleAt: 1_800_000,
    observedAt: 1_800_456,
    preparedParse: {
      channel_alias: 'buddy46',
      cycle_at: 1_800_000,
      observed_at: 1_800_123,
      queue: {
        station_id: 3858517,
        queue_id: 77,
        start_time: 1_800_000,
        is_paused: false,
        is_broadcasting: true,
        host_account_id: 46,
        host_handle: 'buddy46',
        tracks: [],
      },
    },
  });

  assert.equal(runCalls, 1);
  assert.equal(result.pending, true);
  assert.equal(result.stage, 'metadata');
  assert.equal(result.replayed_handoff, undefined);
});
