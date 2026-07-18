import assert from 'node:assert/strict';
import test from 'node:test';

import { processBuddyPlaybackStage } from '../src/buddy-playback-entry.js';
import {
  BUDDY_FETCH_COMPUTE_STAGE,
  processBuddyFetchCompute,
  processBuddyFetchPlan,
} from '../src/buddy-playback-fetch-stages.js';
import { BUDDY_PARSE_COMPUTE_STAGE } from '../src/buddy-playback-parse-stages.js';

function queueBody(overrides = {}) {
  return {
    message_type: 'buddy-playback-stage',
    message_version: 1,
    scheduled_at: 1_800_000,
    observed_at: 1_800_123,
    ...overrides,
  };
}

function statement(sql, state) {
  return {
    sql,
    params: [],
    bind(...params) {
      this.params = params;
      return this;
    },
    async run() {
      state.runs.push({ sql, params: this.params });
      if (sql.includes('INSERT OR IGNORE INTO sh_buddy_playback_pipeline')) state.inserted = true;
      return { meta: { changes: 1 } };
    },
    async first() {
      state.firsts.push({ sql, params: this.params });
      return state.first(sql, this.params);
    },
  };
}

test('production initial message runs fetch planning and queues direct fetch compute', async () => {
  const sent = [];
  let planned = 0;
  const result = await processBuddyPlaybackStage({
    BUDDY_PLAYBACK_ENABLED: true,
    BUDDY_PLAYBACK_QUEUE: {
      async send(body, options) { sent.push({ body, options }); },
    },
  }, queueBody(), {
    fetchPlan: async () => {
      planned += 1;
      return {
        pending: true,
        stage: 'fetch',
        direct_stage: BUDDY_FETCH_COMPUTE_STAGE,
        cycle_at: 1_800_000,
        channel_alias: 'buddy46',
      };
    },
  });

  assert.equal(planned, 1);
  assert.equal(result.requeued, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.direct_stage, BUDDY_FETCH_COMPUTE_STAGE);
  assert.equal(sent[0].body.expected_stage, undefined);
  assert.equal(sent[0].body.cycle_at, 1_800_000);
});

test('fetch plan claims a due cycle without running external collection', async () => {
  const state = {
    inserted: false,
    runs: [],
    firsts: [],
    selectCount: 0,
    first(sql) {
      if (sql.includes('SELECT channel_alias,cycle_at')) {
        state.selectCount += 1;
        if (!state.inserted) return null;
        return {
          channel_alias: 'buddy46',
          cycle_at: 1_800_000,
          stage: 'fetch',
          next_attempt_at: 0,
          lease_until: 0,
        };
      }
      if (sql.startsWith('UPDATE sh_buddy_playback_pipeline SET\n    lease_until=')) {
        return {
          channel_alias: 'buddy46',
          cycle_at: 1_800_000,
          stage: 'fetch',
          next_attempt_at: 0,
          lease_until: 1_890_123,
        };
      }
      throw new Error(`unexpected first SQL: ${sql}`);
    },
  };
  const env = {
    BUDDY_PLAYBACK_ENABLED: true,
    BUDDY_PLAYBACK_INTERVAL_MS: 1_800_000,
    OTHER_DB: {
      prepare(sql) { return statement(sql, state); },
    },
  };

  const result = await processBuddyFetchPlan(env, {
    scheduledAt: 1_800_000,
    observedAt: 1_800_123,
    channelAlias: 'buddy46',
  });

  assert.equal(result.pending, true);
  assert.equal(result.stage, 'fetch');
  assert.equal(result.direct_stage, BUDDY_FETCH_COMPUTE_STAGE);
  assert.equal(state.selectCount, 2);
  assert.equal(state.runs.some(({ sql }) => sql.includes('INSERT OR IGNORE')), true);
});

test('active fetch lease replays the direct handoff instead of losing the task', async () => {
  const state = {
    runs: [],
    firsts: [],
    first(sql) {
      if (sql.includes('SELECT channel_alias,cycle_at')) {
        return {
          channel_alias: 'buddy46',
          cycle_at: 1_800_000,
          stage: 'fetch',
          next_attempt_at: 0,
          lease_until: 1_900_000,
        };
      }
      throw new Error(`unexpected first SQL: ${sql}`);
    },
  };
  const result = await processBuddyFetchPlan({
    BUDDY_PLAYBACK_ENABLED: true,
    BUDDY_PLAYBACK_INTERVAL_MS: 1_800_000,
    OTHER_DB: { prepare(sql) { return statement(sql, state); } },
  }, {
    scheduledAt: 1_800_000,
    observedAt: 1_800_123,
    channelAlias: 'buddy46',
  });

  assert.equal(result.direct_stage, BUDDY_FETCH_COMPUTE_STAGE);
  assert.equal(result.replayed_handoff, true);
  assert.equal(state.firsts.some(({ sql }) => sql.includes('RETURNING channel_alias')), false);
});

test('direct fetch compute stores raw text and hands off to direct parse compute', async () => {
  const state = {
    runs: [],
    firsts: [],
    first(sql) {
      if (sql.includes('SELECT channel_alias,cycle_at')) {
        return {
          channel_alias: 'buddy46',
          cycle_at: 1_800_000,
          stage: 'fetch',
          next_attempt_at: 0,
          lease_until: 1_900_000,
        };
      }
      throw new Error(`unexpected first SQL: ${sql}`);
    },
  };
  const env = {
    BUDDY_PLAYBACK_ENABLED: true,
    OTHER_DB: { prepare(sql) { return statement(sql, state); } },
  };
  const result = await processBuddyFetchCompute(env, {
    channelAlias: 'buddy46',
    cycleAt: 1_800_000,
    observedAt: 1_800_456,
  }, {
    collectReady: async (runtimeEnv, observedAt, dependencies) => dependencies.collect(
      runtimeEnv,
      observedAt,
      {},
    ),
    fetchText: async () => '{"alias":"buddy46"}',
  });

  assert.equal(result.pending, true);
  assert.equal(result.stage, 'parse');
  assert.equal(result.direct_stage, BUDDY_PARSE_COMPUTE_STAGE);
  const update = state.runs.find(({ sql }) => sql.includes("stage='parse',raw_json"));
  assert.ok(update);
  assert.equal(update.params[1], '{"alias":"buddy46"}');
});

test('fetch retry after durable update replays parse without another network call', async () => {
  let fetches = 0;
  const state = {
    runs: [],
    firsts: [],
    first(sql) {
      if (sql.includes('SELECT channel_alias,cycle_at')) {
        return {
          channel_alias: 'buddy46',
          cycle_at: 1_800_000,
          stage: 'parse',
          next_attempt_at: 0,
          lease_until: 0,
        };
      }
      throw new Error(`unexpected first SQL: ${sql}`);
    },
  };
  const result = await processBuddyFetchCompute({
    OTHER_DB: { prepare(sql) { return statement(sql, state); } },
  }, {
    channelAlias: 'buddy46',
    cycleAt: 1_800_000,
    observedAt: 1_800_456,
  }, {
    fetchText: async () => { fetches += 1; return '{}'; },
  });

  assert.equal(fetches, 0);
  assert.equal(result.direct_stage, BUDDY_PARSE_COMPUTE_STAGE);
  assert.equal(result.replayed_handoff, true);
});

test('fetch failure records durable backoff before retrying the Queue message', async () => {
  const state = {
    runs: [],
    firsts: [],
    first(sql) {
      if (sql.includes('SELECT channel_alias,cycle_at')) {
        return {
          channel_alias: 'buddy46',
          cycle_at: 1_800_000,
          stage: 'fetch',
          next_attempt_at: 0,
          lease_until: 1_900_000,
        };
      }
      throw new Error(`unexpected first SQL: ${sql}`);
    },
  };
  await assert.rejects(processBuddyFetchCompute({
    OTHER_DB: { prepare(sql) { return statement(sql, state); } },
  }, {
    channelAlias: 'buddy46',
    cycleAt: 1_800_000,
    observedAt: 1_800_456,
  }, {
    collectReady: async () => { throw new Error('network failed'); },
  }), /network failed/);

  const failure = state.runs.find(({ sql }) => sql.includes('next_attempt_at=?,lease_until=0'));
  assert.ok(failure);
  assert.equal(failure.params[0], 2_100_456);
  assert.equal(failure.params[1], 'network failed');
});

test('old parse-store rows keep the generic compatibility handoff', async () => {
  const state = {
    runs: [],
    firsts: [],
    first(sql) {
      if (sql.includes('SELECT channel_alias,cycle_at')) {
        return {
          channel_alias: 'buddy46',
          cycle_at: 1_800_000,
          stage: 'parse-store',
          next_attempt_at: 0,
          lease_until: 0,
        };
      }
      throw new Error(`unexpected first SQL: ${sql}`);
    },
  };
  const result = await processBuddyFetchPlan({
    BUDDY_PLAYBACK_ENABLED: true,
    BUDDY_PLAYBACK_INTERVAL_MS: 1_800_000,
    OTHER_DB: { prepare(sql) { return statement(sql, state); } },
  }, {
    scheduledAt: 1_800_000,
    observedAt: 1_800_123,
    channelAlias: 'buddy46',
  });

  assert.equal(result.stage, 'parse-store');
  assert.equal(result.direct_stage, undefined);
  assert.equal(result.replayed_handoff, true);
});
