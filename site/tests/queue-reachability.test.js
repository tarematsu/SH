import assert from 'node:assert/strict';
import test from 'node:test';

import {
  QUEUE_REACHABILITY_CHECKPOINT_MS,
  saveQueueReachability,
} from '../functions/lib/queue-reachability.js';
import { FakeD1Database } from './helpers/fake-d1.js';

test('queue reachability writes a compact checkpoint for unchanged queues', async () => {
  const db = new FakeD1Database();
  const observedAt = 1_700_000_000_000;
  const result = await saveQueueReachability(db, observedAt, {
    station_id: 10,
    queue_id: 20,
    start_time: 30,
    is_paused: false,
  });

  assert.equal(result.inserted, true);
  assert.equal(db.calls.length, 1);
  const [call] = db.calls;
  assert.equal(call.kind, 'run');
  assert.match(call.sql, /INSERT INTO sh_queue_snapshots/);
  assert.match(call.sql, /NOT EXISTS/);
  assert.match(call.sql, /observed_at>=\? AND observed_at<=\?/);
  assert.equal(call.params[0], observedAt);
  assert.equal(call.params[11], observedAt - QUEUE_REACHABILITY_CHECKPOINT_MS);
  assert.equal(call.params[12], observedAt);
  assert.equal(call.params[13], 0);
  assert.equal(call.params[5], '{"checkpoint":true}');
});

test('queue reachability preserves paused state for historical reconstruction', async () => {
  const db = new FakeD1Database();
  await saveQueueReachability(db, 1_700_000_120_000, {
    station_id: 10,
    queue_id: 20,
    start_time: 30,
    is_paused: true,
  });

  assert.equal(db.calls[0].params[4], 1);
  assert.equal(db.calls[0].params[13], 1);
});

test('queue reachability does not let a future row suppress a delayed state transition', async () => {
  const db = new FakeD1Database();
  const observedAt = 1_700_000_120_000;

  await saveQueueReachability(db, observedAt, {
    station_id: 10,
    queue_id: 20,
    start_time: 30,
    is_paused: false,
  });

  const [call] = db.calls;
  assert.equal(call.params[11], observedAt - QUEUE_REACHABILITY_CHECKPOINT_MS);
  assert.equal(call.params[12], observedAt);
  assert.match(call.sql, /observed_at<=\?/);
});

test('queue reachability skips invalid queue identities inside SQL', async () => {
  const db = new FakeD1Database();
  await saveQueueReachability(db, 1_700_000_120_000, {
    queue_id: 20,
    is_paused: false,
  });

  const params = db.calls[0].params;
  assert.equal(params[1], null);
  assert.equal(params[3], null);
  assert.match(db.calls[0].sql, /WHERE \? IS NOT NULL AND \? IS NOT NULL AND \? IS NOT NULL/);
});

test('queue reachability rejects an invalid observed time inside SQL', async () => {
  const db = new FakeD1Database();
  await saveQueueReachability(db, 'not-a-time', {
    station_id: 10,
    queue_id: 20,
    start_time: 30,
    is_paused: false,
  });

  const params = db.calls[0].params;
  assert.equal(params[0], null);
  assert.equal(params[6], null);
  assert.equal(params[11], null);
  assert.equal(params[12], null);
});
