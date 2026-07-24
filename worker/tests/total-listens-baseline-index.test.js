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
  new URL('../../database/facts-migrations/039_reduce_fact_write_amplification.sql', import.meta.url),
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

test('facts descriptor advances through the complete live metric restore', () => {
  assert.equal(
    descriptor.schema,
    'database/facts-migrations/041_restore_complete_live_metrics.sql',
  );
});

test('total-listens baselines reuse the existing source-channel-minute index', () => {
  assert.match(migration, /DROP INDEX IF EXISTS idx_sh_minute_facts_total_listens_baseline/);
  assert.match(migration, /DROP INDEX IF EXISTS idx_sh_minute_facts_source_minute_desc/);
  assert.match(
    FACTS_TOTAL_LISTENS_BASELINE_SQL,
    /INDEXED BY idx_sh_minute_facts_source_channel_minute_desc/,
  );
  assert.match(
    FACTS_TOTAL_LISTENS_HOST_BASELINE_SQL,
    /INDEXED BY idx_sh_minute_facts_source_channel_minute_desc/,
  );
  assert.match(
    FACTS_TOTAL_LISTENS_BASELINE_SQL,
    /ORDER BY f\.minute_at DESC,f\.id DESC\s*LIMIT 1/,
  );
  assert.match(FACTS_TOTAL_LISTENS_BASELINE_SQL, /f\.reported_total_listens AS total_listens/);
  assert.match(FACTS_TOTAL_LISTENS_BASELINE_SQL, /f\.reported_total_listens IS NOT NULL/);
  assert.doesNotMatch(FACTS_TOTAL_LISTENS_BASELINE_SQL, /previous\./);
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
