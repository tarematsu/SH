import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { liveSummarySql } from '../site/functions/lib/history-summary.js';
import {
  loadRankingRowsAndWeeks,
  rankingRowsAndWeeksSql,
} from '../site/functions/api/history-ranking.js';

test('live summary SQL aggregates rows inside D1', () => {
  const sql = liveSummarySql('weekly');
  assert.match(sql, /WITH prepared AS/);
  assert.match(sql, /COUNT\(\*\) AS sample_count/);
  assert.match(sql, /GROUP BY period_key/);
  assert.doesNotMatch(sql, /LIMIT 100000/);
});

test('ranking rows and weeks share one statement and one result pass', async () => {
  let allCalls = 0;
  const result = await loadRankingRowsAndWeeks({
    async all() {
      allCalls += 1;
      return {
        results: [
          {
            result_kind: 0,
            ranking_date: '2026-06-01',
            ranking_type: 'weekly',
            rank: 3,
            host_name: 'sakuramankai',
          },
          { result_kind: 1, ranking_date: '2026-06-01' },
        ],
      };
    },
  });

  assert.equal(allCalls, 1);
  assert.equal(result.rows.length, 1);
  assert.deepEqual(result.weeks, ['2026-06-01']);
  assert.deepEqual(result.hostNames, ['sakuramankai']);
  assert.deepEqual(result.rankingTypes, ['weekly']);

  const sql = rankingRowsAndWeeksSql('', 'featured');
  assert.match(sql, /WITH ranged AS/);
  assert.match(sql, /UNION ALL/);
  assert.match(sql, /lower\(host_name\) IN/);
  assert.equal((sql.match(/FROM sh_channel_rankings/g) || []).length, 1);
});

test('active history endpoint keeps the legacy 100k-row path detached', () => {
  const history = readFileSync(new URL('../site/functions/api/history.js', import.meta.url), 'utf8');
  const ranking = readFileSync(new URL('../site/functions/api/history-ranking.js', import.meta.url), 'utf8');
  const legacy = readFileSync(new URL('../site/functions/api/history-legacy.mjs', import.meta.url), 'utf8');

  assert.doesNotMatch(history, /history-legacy\.mjs/);
  assert.match(history, /history-ranking\.js/);
  assert.doesNotMatch(ranking, /LIMIT 100000/);
  assert.match(legacy, /LIMIT 100000/);
});

test('history chart interactions reuse prepared models', () => {
  const summary = readFileSync(
    new URL('../site/public/history/history-multiseries.js', import.meta.url),
    'utf8',
  );
  const ranking = readFileSync(
    new URL('../site/public/history/history-track-likes.js', import.meta.url),
    'utf8',
  );

  assert.match(summary, /summaryModelFor/);
  assert.match(summary, /summaryModelSource === source/);
  assert.match(ranking, /rankingModelFor/);
  assert.match(ranking, /rankingModelSource === values/);
  assert.match(ranking, /const ranks = new Array/);
});

test('goal prediction avoids rewriting unchanged DOM text', () => {
  const source = readFileSync(
    new URL('../site/public/sh-ui-fixes.js', import.meta.url),
    'utf8',
  );
  assert.match(source, /renderPredictionDifferential/);
  assert.match(source, /if \(eta\.textContent !== etaText\)/);
  assert.match(source, /if \(rate\.textContent !== rateText\)/);
});
