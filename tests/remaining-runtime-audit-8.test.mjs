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

test('active history endpoint has no retired raw archive path', () => {
  const history = readFileSync(new URL('../site/functions/api/history.js', import.meta.url), 'utf8');
  const legacy = readFileSync(new URL('../site/functions/api/history-legacy.mjs', import.meta.url), 'utf8');

  assert.doesNotMatch(history, /history-legacy\.mjs/);
  assert.doesNotMatch(legacy, /sh_legacy_(?:history_rows|snapshots)/);
  assert.match(legacy, /export async function loadRanking/);
});

test('history chart interactions reuse prepared models', () => {
  const summary = readFileSync(
    new URL('../site/public/history/history-multiseries.js', import.meta.url),
    'utf8',
  );

  assert.match(summary, /summaryModelFor/);
  assert.match(summary, /summaryModelSource === source/);
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
