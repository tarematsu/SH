import assert from 'node:assert/strict';
import test from 'node:test';

import {
  commitQueueStructurePersistence,
  prepareQueueStructurePersistence,
} from '../src/persist-structure-stages.js';

function body() {
  return {
    collector_id: 'cloudflare-worker',
    data: {
      station_id: 20,
      queue_id: 30,
      start_time: 40,
      is_paused: false,
      tracks: [{ position: 0, spotify_id: 'sp1', isrc: 'JPABC1234567' }],
    },
    analysis: {
      structural_hash: 'structure-hash',
      structural: {
        station_id: 20,
        queue_id: 30,
        start_time: 40,
        is_paused: 0,
        tracks: [{ position: 0, spotify_id: 'sp1', isrc: 'JPABC1234567' }],
      },
    },
  };
}

function statement(sql, state) {
  return {
    sql,
    params: [],
    bind(...params) {
      this.params = params;
      state.prepared.push(this);
      return this;
    },
    async first() {
      return state.first(this.sql, this.params);
    },
    async all() {
      return { results: [] };
    },
    async run() {
      state.ran.push(this);
      return { meta: { changes: 1 } };
    },
  };
}

test('structure planning skips claim and comparison when current hash already matches', async () => {
  const state = {
    prepared: [],
    ran: [],
    first(sql) {
      if (sql.includes('FROM sh_queue_current')) {
        return {
          structural_hash: 'structure-hash',
          likes_hash: 'likes-hash',
          observed_at: 123_000,
          latest_reachability_at: 123_000,
        };
      }
      throw new Error(`unexpected first query: ${sql}`);
    },
  };
  const db = {
    prepare(sql) { return statement(sql, state); },
  };

  const result = await prepareQueueStructurePersistence(db, body(), 123_456);

  assert.equal(result.structure_changed, false);
  assert.equal(result.snapshot_required, false);
  assert.equal(result.structural_hash, 'structure-hash');
  assert.equal(result.likes_hash, 'likes-hash');
  assert.deepEqual(result.all_positions, [0]);
  assert.deepEqual(result.write_positions, []);
  assert.equal(state.ran.length, 0);
});

test('structure commit writes snapshot, bounded items and current state in its own batch', async () => {
  const state = {
    prepared: [],
    ran: [],
    first() { return null; },
  };
  const batches = [];
  const db = {
    prepare(sql) { return statement(sql, state); },
    async batch(statements) {
      batches.push(statements);
      return statements.map(() => ({ success: true, meta: { changes: 1 } }));
    },
  };
  const plan = {
    structure_changed: true,
    snapshot_required: true,
    stale_current: false,
    station_id: 20,
    queue_id: 30,
    start_time: 40,
    structural_hash: 'structure-hash',
    likes_hash: 'likes-hash',
    all_positions: [0],
    write_positions: [0],
    claim: { accepted: true, duplicate: false, reason: 'claimed', hash: 'structure-hash' },
  };

  const result = await commitQueueStructurePersistence(db, body(), 123_456, plan);
  const sql = batches.flat().map((entry) => entry.sql).join('\n');

  assert.equal(result.structureChanged, true);
  assert.equal(result.itemsWritten, 1);
  assert.match(sql, /INSERT INTO sh_queue_snapshots/);
  assert.match(sql, /WHERE NOT EXISTS/);
  assert.match(sql, /INSERT INTO sh_queue_items/);
  assert.match(sql, /INSERT INTO sh_queue_current/);
  assert.match(sql, /DELETE FROM sh_queue_items/);
});
