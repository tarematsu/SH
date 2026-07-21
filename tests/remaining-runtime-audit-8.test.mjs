import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { liveSummarySql } from '../site/functions/lib/history-summary.js';

test('live summary SQL aggregates rows inside D1', () => {
  const sql = liveSummarySql('weekly');
  assert.match(sql, /WITH prepared AS/);
  assert.match(sql, /COUNT\(\*\) AS sample_count/);
  assert.match(sql, /GROUP BY period_key/);
  assert.doesNotMatch(sql, /LIMIT 100000/);
});

test('active history endpoint keeps ranking implementation outside public routes', () => {
  const history = readFileSync(new URL('../site/functions/api/history.js', import.meta.url), 'utf8');
  const ranking = readFileSync(new URL('../site/functions/lib/history-ranking.js', import.meta.url), 'utf8');
  const implementation = readFileSync(new URL('../site/functions/lib/history-legacy.mjs', import.meta.url), 'utf8');

  assert.match(history, /\.\.\/lib\/history-ranking\.js/);
  assert.match(ranking, /\.\/history-legacy\.mjs/);
  assert.doesNotMatch(implementation, /sh_legacy_(?:history_rows|snapshots)/);
  assert.match(implementation, /export async function loadRanking/);
});

test('history client exposes only current canonical modes', () => {
  const source = readFileSync(
    new URL('../site/public/history/history-lite.js', import.meta.url),
    'utf8',
  );

  for (const mode of ['daily', 'weekly', 'monthly', 'ranking', 'tracks', 'broadcasts']) {
    assert.match(source, new RegExp(`${mode}:`));
  }
  assert.match(source, /CACHE_PREFIX = 'sh\.history\.v3:'/);
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
