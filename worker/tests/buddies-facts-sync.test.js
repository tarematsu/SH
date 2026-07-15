import assert from 'node:assert/strict';
import test from 'node:test';

import { runBuddiesFactsSync } from '../src/buddies-facts-sync.js';

function makeSource(rowsByTable) {
  return {
    prepare(sql) {
      return {
        params: [],
        bind(...params) { this.params = params; return this; },
        async all() {
          const table = sql.match(/FROM (sh_[a-z_]+)/i)?.[1];
          return { results: (rowsByTable[table] || []).filter((row) => {
            const cutoff = this.params[0];
            const cursorAt = this.params[1];
            const cursorKey = this.params[3];
            const rowAt = Number(row.observed_at ?? row.fetched_at);
            const rowKey = row.spotify_id || Number(row.id);
            return rowAt < cutoff
              && (rowAt > cursorAt || (rowAt === cursorAt && String(rowKey) > String(cursorKey || 0)));
          }).slice(0, this.params.at(-1)) };
        },
      };
    },
  };
}

function makeFacts(states, batches, updates) {
  return {
    prepare(sql) {
      return {
        params: [],
        bind(...params) { this.params = params; return this; },
        async first() {
          return states[this.params[0]] || null;
        },
        async run() {
          if (sql.includes('UPDATE sh_buddies_sync_state')) updates.push({ sql, params: this.params });
          return { meta: { changes: 1 } };
        },
      };
    },
    async batch(statements) {
      batches.push(statements.map((statement) => statement.sql || ''));
      return statements.map(() => ({ success: true }));
    },
  };
}

test('buddies sync drains compact source tables with independent durable cursors', async () => {
  const now = 10_000_000;
  const source = makeSource({
    sh_queue_items: [{ id: 1, observed_at: 1_000, position: 0, station_id: 2 }],
    sh_track_like_observations: [{ id: 2, observed_at: 2_000, track_key: 'spotify:t', like_count: 4 }],
    sh_track_metadata: [{ spotify_id: 't', fetched_at: 3_000, title: 'Song' }],
  });
  const states = {
    'queue-items': { sync_key: 'queue-items' },
    'track-likes': { sync_key: 'track-likes' },
    'track-metadata': { sync_key: 'track-metadata' },
  };
  const batches = [];
  const updates = [];
  const result = await runBuddiesFactsSync({
    DB: source,
    MINUTE_DB: makeFacts(states, batches, updates),
    BUDDIES_SYNC_SOURCE_LAG_MS: 0,
  }, { now, limit: 10 });

  assert.equal(result.failed, false);
  assert.equal(result.rows, 3);
  assert.equal(batches.length, 3);
  assert.equal(updates.length, 3);
  assert.deepEqual(updates.map(({ params }) => params.at(-1)), [
    'queue-items', 'track-likes', 'track-metadata',
  ]);
});
