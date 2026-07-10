import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  DASHBOARD_CONTEXT_SQL,
  loadDashboardContext,
  loadDashboardQueue,
} from '../site/functions/api/dashboard.js';
import {
  cachedHostSummary,
  resetHostSummaryCache,
} from '../site/functions/api/host-history.js';

test('dashboard context SQL returns latest snapshot and queue revision state in one row', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sh_channel_snapshots (
      id INTEGER PRIMARY KEY,observed_at INTEGER,channel_id INTEGER,channel_alias TEXT,
      channel_name TEXT,station_id INTEGER,is_launched INTEGER,is_broadcasting INTEGER,
      chat_status TEXT,listener_count INTEGER,online_member_count INTEGER,
      total_member_count INTEGER,guest_count INTEGER,total_listens INTEGER,
      stream_goal INTEGER,current_stream_count INTEGER,host_account_id INTEGER,
      host_handle TEXT,broadcast_start_time INTEGER,comment_velocity INTEGER,raw_json TEXT
    );
    CREATE TABLE sh_queue_current (
      station_id INTEGER PRIMARY KEY,queue_id INTEGER,start_time INTEGER,
      structural_hash TEXT NOT NULL,likes_hash TEXT,is_paused INTEGER,
      observed_at INTEGER NOT NULL,updated_at INTEGER NOT NULL
    );
    CREATE TABLE sh_queue_items (
      id INTEGER PRIMARY KEY,observed_at INTEGER,station_id INTEGER,start_time INTEGER,
      position INTEGER,spotify_id TEXT
    );
    CREATE TABLE sh_track_metadata (
      spotify_id TEXT PRIMARY KEY,fetched_at INTEGER
    );
  `);
  db.prepare(`INSERT INTO sh_channel_snapshots VALUES(
    1,1000,10,'buddies','Old',20,1,1,'live',10,11,12,13,14,15,16,17,'old',18,1,'{}'
  )`).run();
  db.prepare(`INSERT INTO sh_channel_snapshots VALUES(
    2,2000,10,'buddies','Latest',21,1,1,'live',20,21,22,23,24,25,26,27,'latest',28,2,'{}'
  )`).run();
  db.prepare("INSERT INTO sh_queue_current VALUES(21,31,3000,'hash',NULL,0,2100,2100)").run();
  db.prepare("INSERT INTO sh_queue_items VALUES(1,2200,21,3000,0,'a')").run();
  db.prepare("INSERT INTO sh_queue_items VALUES(2,2300,21,3000,1,'b')").run();
  db.prepare("INSERT INTO sh_track_metadata VALUES('a',2400)").run();
  db.prepare("INSERT INTO sh_track_metadata VALUES('b',2500)").run();

  const row = db.prepare(DASHBOARD_CONTEXT_SQL).get();
  assert.equal(row.channel_name, 'Latest');
  assert.equal(row.station_id, 21);
  assert.equal(row.queue_station_id, 21);
  assert.equal(row.queue_id, 31);
  assert.equal(row.item_observed_at, 2300);
  assert.equal(row.metadata_fetched_at, 2500);
  assert.equal(row.total_items, 2);
});

test('dashboard latest row and unchanged queue share one context query', async () => {
  let prepareCalls = 0;
  let firstCalls = 0;
  let queueAllCalls = 0;
  const row = {
    observed_at: 2000,
    station_id: 21,
    host_account_id: 27,
    queue_station_id: 21,
    queue_id: 31,
    queue_start_time: 3000,
    queue_is_paused: 0,
    queue_observed_at: 2100,
    item_observed_at: 2300,
    metadata_fetched_at: 2500,
    total_items: 2,
  };
  const db = {
    prepare(sql) {
      prepareCalls += 1;
      assert.equal(sql, DASHBOARD_CONTEXT_SQL);
      return {
        async first() {
          firstCalls += 1;
          await new Promise((resolve) => setTimeout(resolve, 5));
          return row;
        },
      };
    },
  };
  const context = {
    requestedRevision: '21:31:3000:0:::2300:2500:2:id:27',
    revision: '',
    state: null,
    hostIdentity: '',
    unchanged: false,
    contextPromise: null,
  };
  const queueStatement = {
    async all() {
      queueAllCalls += 1;
      return { results: [] };
    },
  };

  const [latest, queueResult] = await Promise.all([
    loadDashboardContext(db, context),
    loadDashboardQueue(queueStatement, db, context),
  ]);
  assert.strictEqual(latest, row);
  assert.equal(prepareCalls, 1);
  assert.equal(firstCalls, 1);
  assert.equal(queueAllCalls, 0);
  assert.equal(context.unchanged, true);
  assert.equal(queueResult.results[0].queue_id, 31);
});

test('host summary cache coalesces concurrent D1 batches per binding', async () => {
  resetHostSummaryCache();
  let batches = 0;
  const db = {
    prepare(sql) { return { sql }; },
    async batch(statements) {
      batches += 1;
      assert.equal(statements.length, 3);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return [
        { results: [{ handle: 'sakuramankai', followers: 100 }] },
        { results: [{ handle: 'sakurazaka46jp', status: 'active' }] },
        { results: [{ id: 1 }, { id: 2 }] },
      ];
    },
  };

  const [first, second] = await Promise.all([
    cachedHostSummary(db),
    cachedHostSummary(db),
  ]);
  assert.strictEqual(first, second);
  assert.equal(batches, 1);
  assert.strictEqual(await cachedHostSummary(db), first);
  assert.equal(batches, 1);
});

test('main chart uses shared formatters, single-pass preparation and differential DOM updates', () => {
  const source = readFileSync(
    new URL('../site/public/sh-ui-fixes.js', import.meta.url),
    'utf8',
  );
  assert.match(source, /const integerFormatter = new Intl\.NumberFormat/);
  assert.match(source, /const tickDateTimeFormatter = new Intl\.DateTimeFormat/);
  assert.match(source, /for \(let index = 0; index < sampled\.length; index \+= 1\)/);
  assert.match(source, /if \(canvas\.width !== pixelWidth\)/);
  assert.match(source, /if \(detail\.innerHTML !== html\)/);
  assert.doesNotMatch(source, /toLocaleString\(/);
  assert.doesNotMatch(source, /toLocaleDateString\(/);
  assert.doesNotMatch(source, /sampled\.map\(\(row\) => Number\(row\.online_member_count\)\)/);
});
