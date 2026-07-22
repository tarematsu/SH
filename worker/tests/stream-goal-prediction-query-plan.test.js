import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { STREAM_GOAL_PREDICTION_AGGREGATE_SQL } from '../src/stream-goal-prediction.js';

test('stream-goal prediction bounds samples and seeks the latest live fact', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sh_minute_facts(
      id INTEGER PRIMARY KEY,
      channel_id INTEGER NOT NULL,
      minute_at INTEGER NOT NULL,
      observed_at INTEGER NOT NULL,
      source_code INTEGER NOT NULL,
      is_broadcasting INTEGER,
      reported_current_stream_count INTEGER
    );
    CREATE INDEX idx_sh_minute_facts_stream_observed
      ON sh_minute_facts(observed_at,id)
      WHERE reported_current_stream_count IS NOT NULL;
    CREATE INDEX idx_sh_minute_facts_live_minute
      ON sh_minute_facts(source_code,minute_at DESC,id DESC,channel_id,observed_at,is_broadcasting);
    CREATE TABLE sh_channel_read_model(
      channel_id INTEGER PRIMARY KEY,
      presentation_json TEXT
    );
  `);

  const plan = db.prepare(`EXPLAIN QUERY PLAN ${STREAM_GOAL_PREDICTION_AGGREGATE_SQL}`)
    .all(0)
    .map(({ detail }) => String(detail));

  assert.ok(
    plan.some((detail) => detail.includes(
      'idx_sh_minute_facts_stream_observed (observed_at>?)',
    )),
    `expected a bounded prediction sample scan: ${plan.join(' | ')}`,
  );
  assert.ok(
    plan.some((detail) => detail.includes(
      'idx_sh_minute_facts_live_minute (source_code=?)',
    )),
    `expected a latest-live seek: ${plan.join(' | ')}`,
  );
  db.close();
});
