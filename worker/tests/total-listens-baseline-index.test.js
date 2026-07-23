import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  FACTS_TOTAL_LISTENS_BASELINE_SQL,
  FACTS_TOTAL_LISTENS_HOST_BASELINE_SQL,
  loadFactsBaseline,
} from '../../site/functions/lib/dashboard-facts.js';

const descriptor = JSON.parse(readFileSync(
  new URL('../../database/facts-db.json', import.meta.url),
  'utf8',
));
const migration = readFileSync(
  new URL('../../database/facts-migrations/022_total_listens_baseline_index.sql', import.meta.url),
  'utf8',
);

function recordingDb() {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      const call = { sql, args: [] };
      calls.push(call);
      return {
        bind(...args) {
          call.args = args;
          return this;
        },
        async first() {
          return { observed_at: 200, total_listens: 300 };
        },
      };
    },
  };
}

test('facts descriptor advances beyond the total-listens baseline index', () => {
  assert.equal(
    descriptor.schema,
    'database/facts-migrations/037_remaining_d1_hotpaths.sql',
  );
});

test('the baseline migration replaces the ineffective observed-time-first index', () => {
  assert.match(migration, /DROP INDEX IF EXISTS idx_sh_minute_facts_total_listens_baseline/);
  assert.match(migration, /CREATE INDEX idx_sh_minute_facts_total_listens_baseline/);
  assert.match(
    migration,
    /channel_id,\s*minute_at DESC,\s*id DESC,\s*observed_at,\s*reported_total_listens/s,
  );
  assert.match(
    migration,
    /WHERE source_code=1 AND reported_total_listens IS NOT NULL/,
  );
  assert.match(
    FACTS_TOTAL_LISTENS_BASELINE_SQL,
    /ORDER BY f\.minute_at DESC,f\.id DESC\s*LIMIT 1/,
  );
});

test('hostless total-listens baselines stay on the latest channel and avoid a context join', async () => {
  const db = recordingDb();
  const result = await loadFactsBaseline(db, 'total_listens', null, 100, 200);

  assert.deepEqual(result, { observed_at: 200, total_listens: 300 });
  assert.equal(db.calls.length, 1);
  assert.equal(db.calls[0].sql, FACTS_TOTAL_LISTENS_BASELINE_SQL);
  assert.deepEqual(db.calls[0].args, [100, 200]);
  assert.match(db.calls[0].sql, /f\.channel_id=\(SELECT channel_id FROM latest_channel\)/);
  assert.doesNotMatch(db.calls[0].sql, /sh_minute_fact_context/);
});

test('host-filtered total-listens baselines retain the explicit context join', async () => {
  const db = recordingDb();
  await loadFactsBaseline(db, 'total_listens', 42, 100, 200);

  assert.equal(db.calls.length, 1);
  assert.equal(db.calls[0].sql, FACTS_TOTAL_LISTENS_HOST_BASELINE_SQL);
  assert.deepEqual(db.calls[0].args, [100, 200, 42]);
  assert.match(db.calls[0].sql, /JOIN sh_minute_fact_context AS c/);
  assert.match(db.calls[0].sql, /c\.host_id=\?/);
});

test('member baselines use the latest channel before applying the daily range', async () => {
  const db = recordingDb();
  await loadFactsBaseline(db, 'total_member_count', null, 100, 200);

  assert.equal(db.calls.length, 1);
  assert.match(db.calls[0].sql, /FROM sh_total_member_daily d/);
  assert.match(db.calls[0].sql, /d\.channel_id=\(SELECT channel_id FROM latest_channel\)/);
  assert.deepEqual(db.calls[0].args, [100, 200, null, 0]);
});
