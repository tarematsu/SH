import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { HOST_SUMMARY_SQL, loadHostSummary } from '../site/functions/api/host-history.js';

test('host summary returns profile, active session and recent sessions from one SQL statement', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sh_host_profile_snapshots (
      observed_at INTEGER,handle TEXT,account_id INTEGER,followers INTEGER,
      following INTEGER,total_streams INTEGER,active_stream_days INTEGER,thumbnail_url TEXT
    );
    CREATE TABLE sh_host_broadcast_sessions (
      id INTEGER,handle TEXT,station_id INTEGER,started_at INTEGER,confirmed_at INTEGER,
      ended_at INTEGER,status TEXT,peak_listeners INTEGER,average_listeners REAL,
      total_listens_start INTEGER,total_listens_end INTEGER,listener_sample_count INTEGER,
      track_count INTEGER,comment_count INTEGER,last_observed_at INTEGER
    );
  `);
  db.prepare(`INSERT INTO sh_host_profile_snapshots VALUES
    (100,'sakuramankai',1,10,20,30,40,'old'),
    (200,'sakuramankai',1,11,21,31,41,'latest')`).run();
  db.prepare(`INSERT INTO sh_host_broadcast_sessions VALUES
    (1,'sakurazaka46jp',10,100,110,200,'ended',30,20,1000,1100,2,3,4,200),
    (2,'sakurazaka46jp',11,300,310,NULL,'active',40,NULL,1200,NULL,3,4,5,320)`).run();

  let statements = 0;
  const wrapped = {
    prepare(sql) {
      statements += 1;
      assert.equal(sql, HOST_SUMMARY_SQL);
      const statement = db.prepare(sql);
      return { all: async () => ({ results: statement.all() }) };
    },
  };
  const summary = await loadHostSummary(wrapped);
  assert.equal(statements, 1);
  assert.equal(summary.latestProfile.followers, 11);
  assert.equal(summary.activeSession.id, 2);
  assert.deepEqual(summary.recentSessions.map((row) => row.id), [2, 1]);
});

test('history runtime consolidates enhancements and reuses prepared chart state', () => {
  const html = readFileSync(new URL('../site/public/history/index.html', import.meta.url), 'utf8');
  assert.equal((html.match(/<script /g) || []).length, 1);
  assert.match(html, /src="\/history\/history-lite\.js"/);
  assert.doesNotMatch(html, /history-copy-fixes\.js|history-track-performance\.js|history-track-likes\.js/);

  const runtime = readFileSync(
    new URL('../site/public/history/history-lite.js', import.meta.url),
    'utf8',
  );
  assert.match(runtime, /function positionsFromTimes/);
  assert.match(runtime, /function drawDateAxis/);
  assert.match(runtime, /state\.chartModel = \{ type: 'summary', positions, rows \}/);
  assert.match(runtime, /const positions = state\.chartModel\.positions/);
  assert.match(runtime, /const PAGE_SIZE = 200/);
  assert.match(runtime, /sessionStorage\.getItem/);
});
