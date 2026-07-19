import assert from 'node:assert/strict';
import test from 'node:test';

import { runPagesSixHourTask } from '../src/pages-six-hour-read-model.js';

class FakeDb {
  constructor() { this.calls = []; }
  prepare(sql) {
    const db = this;
    return {
      params: [],
      bind(...params) { this.params = params; return this; },
      async run() { db.calls.push({ method: 'run', sql, params: this.params }); return { meta: { changes: 0 } }; },
      async first() { db.calls.push({ method: 'first', sql, params: this.params }); return null; },
    };
  }
}

test('six-hour variants publish through KV without provisioning D1 response tables', async () => {
  const db = new FakeDb();
  const kv = { put() {} };
  const saved = [];
  const now = Date.UTC(2026, 6, 20, 0, 35);
  const result = await runPagesSixHourTask({
    BUDDIES_DB: {},
    MINUTE_DB: db,
    OTHER_DB: {},
    PAGES_RESPONSE_KV: kv,
  }, now, {
    render: async () => Response.json({ ok: true }),
    saveResponse: async (...args) => {
      saved.push(args);
      return { storage: 'kv', bytes: 11, chunks: 1 };
    },
  });

  assert.equal(result.failed, 0);
  assert.equal(result.responses[0].storage, 'kv');
  assert.equal(saved.length, 1);
  assert.equal(saved[0][0], db);
  assert.equal(saved[0][1], kv);
  assert.equal(saved[0][2], 'history:daily');
  assert.equal(saved[0][5], 21_600);
  assert.equal(db.calls.some(({ sql }) => sql.includes('sh_pages_response_manifest')), false);
  assert.equal(db.calls.some(({ sql }) => sql.includes('sh_pages_payload_read_model')), true);
});
