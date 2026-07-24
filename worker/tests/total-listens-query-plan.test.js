import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { FACTS_TOTAL_LISTENS_BASELINE_SQL } from '../../site/functions/lib/dashboard-facts.js';

const baselineMigration = readFileSync(
  new URL('../../database/facts-migrations/022_total_listens_baseline_index.sql', import.meta.url),
  'utf8',
);
const reductionMigration = readFileSync(
  new URL('../../database/facts-migrations/039_reduce_fact_write_amplification.sql', import.meta.url),
  'utf8',
);

test('SQLite range-seeks the current channel baseline through the shared channel-minute index', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sh_minute_facts (
      id INTEGER PRIMARY KEY,
      channel_id INTEGER NOT NULL,
      minute_at INTEGER NOT NULL,
      observed_at INTEGER NOT NULL,
      source_code INTEGER NOT NULL,
      reported_total_listens INTEGER
    );
    CREATE INDEX idx_sh_minute_facts_source_channel_minute_desc
      ON sh_minute_facts(source_code,channel_id,minute_at DESC,id DESC);
    CREATE INDEX idx_sh_minute_facts_source_minute_desc
      ON sh_minute_facts(source_code,minute_at DESC,id DESC,channel_id,observed_at);
    ${baselineMigration}
    ${reductionMigration}
    INSERT INTO sh_minute_facts VALUES
      (1,7,150,151,1,700),
      (2,7,180,181,1,800),
      (3,9,190,191,1,900),
      (4,7,300,301,1,1000);
  `);

  const statement = db.prepare(FACTS_TOTAL_LISTENS_BASELINE_SQL);
  const row = statement.get(100, 200);
  assert.deepEqual({ ...row }, { observed_at: 181, total_listens: 800 });

  const plan = db.prepare(`EXPLAIN QUERY PLAN ${FACTS_TOTAL_LISTENS_BASELINE_SQL}`)
    .all(100, 200)
    .map(({ detail }) => String(detail));

  assert.ok(
    plan.some((detail) => detail.includes(
      'SEARCH f USING INDEX idx_sh_minute_facts_source_channel_minute_desc (source_code=? AND channel_id=? AND minute_at>? AND minute_at<?)',
    )),
    `expected a channel and minute range seek: ${plan.join(' | ')}`,
  );
  assert.ok(
    plan.every((detail) => !detail.includes('sh_minute_fact_context')),
    `hostless query unexpectedly touches context: ${plan.join(' | ')}`,
  );
  assert.ok(
    plan.every((detail) => !detail.includes('USE TEMP B-TREE FOR ORDER BY')),
    `baseline query unexpectedly sorts the result set: ${plan.join(' | ')}`,
  );
});
