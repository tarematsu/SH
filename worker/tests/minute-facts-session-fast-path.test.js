import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { resolveLiveSession } from '../src/minute-facts-legacy-resolve.js';

function createDatabase() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`CREATE TABLE sh_broadcast_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_key TEXT NOT NULL UNIQUE,
    channel_id INTEGER NOT NULL,
    station_id INTEGER,
    host_id INTEGER,
    broadcast_start_time INTEGER,
    first_observed_at INTEGER NOT NULL,
    last_observed_at INTEGER NOT NULL,
    ended_at INTEGER,
    status TEXT NOT NULL,
    source TEXT NOT NULL
  )`);
  const prepared = [];
  return {
    sqlite,
    prepared,
    prepare(sql) {
      prepared.push(String(sql));
      const statement = sqlite.prepare(sql);
      return {
        bind(...params) {
          return {
            async first() {
              return statement.get(...params) || null;
            },
            async all() {
              return { results: statement.all(...params) };
            },
            async run() {
              const result = statement.run(...params);
              return { meta: { changes: Number(result.changes || 0) } };
            },
          };
        },
      };
    },
  };
}

function insertActive(db, overrides = {}) {
  const row = {
    sessionKey: 'live:318:1700000000000:20:10',
    channelId: 318,
    stationId: 10,
    hostId: 20,
    broadcastStart: 1_700_000_000_000,
    observedAt: 1_700_000_060_000,
    ...overrides,
  };
  db.sqlite.prepare(`INSERT INTO sh_broadcast_sessions(
      session_key,channel_id,station_id,host_id,broadcast_start_time,
      first_observed_at,last_observed_at,ended_at,status,source
    ) VALUES(?,?,?,?,?,?,?,NULL,'active','live_collector')`).run(
    row.sessionKey,
    row.channelId,
    row.stationId,
    row.hostId,
    row.broadcastStart,
    row.observedAt,
    row.observedAt,
  );
}

test('matching live session continues with one D1 statement', async () => {
  const db = createDatabase();
  insertActive(db);
  const observedAt = 1_700_000_120_000;

  const sessionId = await resolveLiveSession(db, {
    channelId: 318,
    stationId: 10,
    hostId: 20,
    broadcastStartTime: 1_700_000_000,
    isBroadcasting: true,
    observedAt,
  });

  assert.equal(sessionId, 1);
  assert.equal(db.prepared.length, 1);
  assert.match(db.prepared[0], /^UPDATE sh_broadcast_sessions/);
  assert.match(db.prepared[0], /RETURNING id/);
  const row = db.sqlite.prepare('SELECT last_observed_at,status FROM sh_broadcast_sessions WHERE id=1').get();
  assert.equal(row.last_observed_at, observedAt);
  assert.equal(row.status, 'active');
});

test('session identity changes retain the end-and-create fallback', async () => {
  const db = createDatabase();
  insertActive(db);
  const observedAt = 1_700_000_120_000;

  const sessionId = await resolveLiveSession(db, {
    channelId: 318,
    stationId: 11,
    hostId: 20,
    broadcastStartTime: 1_700_000_000,
    isBroadcasting: true,
    observedAt,
  });

  assert.equal(sessionId, 2);
  const previous = db.sqlite.prepare('SELECT status,ended_at FROM sh_broadcast_sessions WHERE id=1').get();
  assert.equal(previous.status, 'ended');
  assert.equal(previous.ended_at, observedAt);
  const current = db.sqlite.prepare('SELECT station_id,status FROM sh_broadcast_sessions WHERE id=2').get();
  assert.equal(current.station_id, 11);
  assert.equal(current.status, 'active');
});
