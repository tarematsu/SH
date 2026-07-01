import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { decorateQueueResponse } from '../site/functions/api/dashboard.js';
import {
  DASHBOARD_QUEUE_STATE_SQL,
  hostIdentity,
  parseQueueState,
  queueRevision,
} from '../site/functions/lib/queue-state.js';

function database() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sh_channel_snapshots (
      id INTEGER PRIMARY KEY, observed_at INTEGER NOT NULL, station_id INTEGER,
      host_account_id INTEGER, host_handle TEXT
    );
    CREATE TABLE sh_queue_snapshots (
      id INTEGER PRIMARY KEY, observed_at INTEGER NOT NULL, station_id INTEGER,
      queue_id INTEGER, start_time INTEGER, is_paused INTEGER
    );
    CREATE TABLE sh_queue_items (
      id INTEGER PRIMARY KEY, observed_at INTEGER NOT NULL, station_id INTEGER,
      start_time INTEGER, position INTEGER, spotify_id TEXT
    );
    CREATE TABLE sh_track_metadata (
      spotify_id TEXT PRIMARY KEY, fetched_at INTEGER
    );
  `);
  return db;
}

test('dashboard queue revision changes only when queue state or metadata changes', () => {
  const db = database();
  db.exec(`
    INSERT INTO sh_channel_snapshots VALUES (1,1000,20,42,'host');
    INSERT INTO sh_queue_snapshots VALUES (1,2000,20,7,3000,0);
    INSERT INTO sh_queue_items VALUES (1,2100,20,3000,0,'a');
    INSERT INTO sh_queue_items VALUES (2,2200,20,3000,1,'b');
    INSERT INTO sh_track_metadata VALUES ('a',5000);
    INSERT INTO sh_track_metadata VALUES ('b',6000);
  `);

  const firstRow = db.prepare(DASHBOARD_QUEUE_STATE_SQL).get();
  const firstState = parseQueueState(firstRow);
  const firstRevision = queueRevision(firstState, hostIdentity(firstRow));
  assert.equal(firstState.total_items, 2);
  assert.equal(firstState.item_observed_at, 2200);
  assert.equal(firstState.metadata_fetched_at, 6000);
  assert.match(firstRevision, /^20:7:3000:0:2200:6000:2:id:42$/);

  db.prepare('UPDATE sh_track_metadata SET fetched_at=? WHERE spotify_id=?').run(7000, 'a');
  const secondRow = db.prepare(DASHBOARD_QUEUE_STATE_SQL).get();
  const secondRevision = queueRevision(parseQueueState(secondRow), hostIdentity(secondRow));
  assert.notEqual(secondRevision, firstRevision);
});

test('unchanged dashboard queue response omits rows but keeps playback status', () => {
  const context = {
    revision: '20:7:3000:0:2200:6000:2:id:42',
    state: { total_items: 2 },
    hostIdentity: 'id:42',
    unchanged: true,
  };
  const result = decorateQueueResponse({
    ok: true,
    latest: { is_broadcasting: 1, host_account_id: 42 },
    queue: [{ title: 'should not be sent' }],
    queue_status: { is_paused: 0, playing: false, total_items: 0 },
  }, context);

  assert.deepEqual(result.queue, []);
  assert.equal(result.queue_unchanged, true);
  assert.equal(result.queue_status.playing, true);
  assert.equal(result.queue_status.total_items, 2);
});
