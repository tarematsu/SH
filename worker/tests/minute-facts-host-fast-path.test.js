import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { resolveHost } from '../src/minute-facts-legacy-resolve.js';

function createDatabase() {
  const sqlite = new DatabaseSync(':memory:');
  const preparedSql = [];
  sqlite.exec(`
    CREATE TABLE sh_hosts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      canonical_key TEXT NOT NULL UNIQUE,
      stationhead_account_id INTEGER,
      current_handle TEXT,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    );
    CREATE TABLE sh_host_aliases (
      alias_type TEXT NOT NULL,
      alias_value TEXT NOT NULL,
      host_id INTEGER NOT NULL,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      PRIMARY KEY(alias_type,alias_value)
    );
  `);
  return {
    sqlite,
    preparedSql,
    prepare(sql) {
      preparedSql.push(sql);
      const statement = sqlite.prepare(sql);
      return {
        bind(...params) {
          return {
            async first() {
              return statement.get(...params) || null;
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

test('existing host resolution preserves alias priority in two D1 statements', async () => {
  const db = createDatabase();
  db.sqlite.exec(`
    INSERT INTO sh_hosts(id,canonical_key,stationhead_account_id,current_handle,first_seen_at,last_seen_at)
      VALUES(1,'stationhead_account_id:123',123,'old',10,10);
    INSERT INTO sh_hosts(id,canonical_key,stationhead_account_id,current_handle,first_seen_at,last_seen_at)
      VALUES(2,'handle:host',NULL,'host',10,10);
    INSERT INTO sh_host_aliases VALUES('stationhead_account_id','123',1,10,10);
    INSERT INTO sh_host_aliases VALUES('handle','host',2,10,10);
  `);
  db.preparedSql.length = 0;

  const hostId = await resolveHost(db, { accountId: 123, handle: 'HOST' }, 200);

  assert.equal(hostId, 1);
  const host = db.sqlite.prepare('SELECT current_handle,last_seen_at FROM sh_hosts WHERE id=1').get();
  assert.equal(host.current_handle, 'HOST');
  assert.equal(Number(host.last_seen_at), 200);
  const aliases = db.sqlite.prepare(`SELECT alias_type,alias_value,host_id,last_seen_at
    FROM sh_host_aliases ORDER BY alias_type`).all();
  assert.deepEqual(aliases.map((row) => ({
    alias_type: row.alias_type,
    alias_value: row.alias_value,
    host_id: Number(row.host_id),
    last_seen_at: Number(row.last_seen_at),
  })), [
    { alias_type: 'handle', alias_value: 'host', host_id: 2, last_seen_at: 200 },
    { alias_type: 'stationhead_account_id', alias_value: '123', host_id: 1, last_seen_at: 200 },
  ]);
  assert.equal(db.preparedSql.length, 2);
  assert.match(db.preparedSql[0], /UPDATE sh_hosts SET[\s\S]*RETURNING id/);
  assert.match(db.preparedSql[1], /INSERT INTO sh_host_aliases[\s\S]*VALUES \(\?,\?,\?,\?,\?\),\(\?,\?,\?,\?,\?\)/);
});

test('missing host retains canonical creation and alias hydration fallback', async () => {
  const db = createDatabase();
  db.preparedSql.length = 0;

  const hostId = await resolveHost(db, { accountId: 999, handle: 'NewHost' }, 300);

  assert.equal(hostId, 1);
  const host = db.sqlite.prepare('SELECT * FROM sh_hosts WHERE id=1').get();
  assert.equal(host.canonical_key, 'stationhead_account_id:999');
  assert.equal(Number(host.stationhead_account_id), 999);
  assert.equal(host.current_handle, 'NewHost');
  const aliases = db.sqlite.prepare(`SELECT alias_type,alias_value,host_id
    FROM sh_host_aliases ORDER BY alias_type`).all();
  assert.deepEqual(aliases.map((row) => [row.alias_type, row.alias_value, Number(row.host_id)]), [
    ['handle', 'newhost', 1],
    ['stationhead_account_id', '999', 1],
  ]);
  assert.equal(db.preparedSql.length, 5);
});
