import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  liveSummarySql,
  loadSummaryWithLive,
} from '../site/functions/lib/history-summary.js';
import { loadRankingRowsAndWeeks } from '../site/functions/api/history-ranking.js';

test('ranking weekly metrics use the same SQLite aggregate as summary history', async () => {
  const prepared = [];
  const env = {
    DB: {
      prepare(sql) {
        const statement = {
          sql,
          values: [],
          bind(...values) {
            this.values = values;
            return this;
          },
          async all() {
            if (sql.includes('FROM sh_weekly_summary')) return { results: [] };
            return {
              results: [{
                period_key: '2026-06-01',
                period_start: Date.parse('2026-05-31T15:05:00Z'),
                period_end: Date.parse('2026-06-07T14:55:00Z'),
                sample_count: 100,
                reliable_sample_count: 100,
                listener_avg: 10,
                listener_min: 5,
                listener_max: 20,
                stream_start: 1000,
                stream_end: 1500,
                member_start: 100,
                member_end: 110,
                primary_host: 'buddies',
              }],
            };
          },
        };
        prepared.push(statement);
        return statement;
      },
    },
  };

  const result = await loadSummaryWithLive(
    env,
    'weekly',
    '2026-06-01',
    '2026-06-07',
    Date.parse('2026-06-10T00:00:00Z'),
  );

  assert.equal(prepared.length, 2);
  assert.match(prepared[1].sql, /GROUP BY period_key/);
  assert.doesNotMatch(prepared[1].sql, /LIMIT 100000/);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].stream_growth, 500);
});

test('live summary SQL aggregates before rows leave D1', () => {
  const sql = liveSummarySql('weekly');
  assert.match(sql, /WITH prepared AS/);
  assert.match(sql, /COUNT\(\*\) AS sample_count/);
  assert.match(sql, /GROUP BY period_key/);
  assert.doesNotMatch(sql, /SELECT observed_at,listener_count.*LIMIT 100000/s);
});

test('ranking rows and distinct weeks share one D1 batch', async () => {
  let batchCalls = 0;
  let individualCalls = 0;
  const rankingStatement = { all: async () => { individualCalls += 1; return { results: [] }; } };
  const weeksStatement = { all: async () => { individualCalls += 1; return { results: [] }; } };
  const db = {
    async batch(statements) {
      batchCalls += 1;
      assert.deepEqual(statements, [rankingStatement, weeksStatement]);
      return [{ results: [{ ranking_date: '2026-06-01' }] }, { results: [{ ranking_date: '2026-06-01' }] }];
    },
  };

  const result = await loadRankingRowsAndWeeks(db, rankingStatement, weeksStatement);
  assert.equal(batchCalls, 1);
  assert.equal(individualCalls, 0);
  assert.equal(result.length, 2);
});

test('active history endpoint no longer bundles the legacy 100k-row aggregator', () => {
  const history = readFileSync(new URL('../site/functions/api/history.js', import.meta.url), 'utf8');
  const ranking = readFileSync(new URL('../site/functions/api/history-ranking.js', import.meta.url), 'utf8');
  const legacy = readFileSync(new URL('../site/functions/api/history-legacy.mjs', import.meta.url), 'utf8');

  assert.doesNotMatch(history, /history-legacy\.mjs/);
  assert.match(history, /history-ranking\.js/);
  assert.match(history, /history-raw\.js/);
  assert.doesNotMatch(ranking, /LIMIT 100000/);
  assert.match(legacy, /LIMIT 100000/);
});

test('goal prediction avoids rewriting unchanged DOM text', () => {
  const source = readFileSync(
    new URL('../site/public/stationhead-ui-fixes.js', import.meta.url),
    'utf8',
  );
  assert.match(source, /renderPredictionDifferential/);
  assert.match(source, /if \(eta\.textContent !== etaText\)/);
  assert.match(source, /if \(rate\.textContent !== rateText\)/);
});
