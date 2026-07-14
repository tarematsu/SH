import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const historyPage = readFileSync(new URL('../public/history/index.html', import.meta.url), 'utf8');
const historyFixes = readFileSync(new URL('../public/history/history-copy-fixes.js', import.meta.url), 'utf8');
const historyCurrent = readFileSync(new URL('../public/history/history-current.js', import.meta.url), 'utf8');

test('history page exposes the current and leaderboard tabs', () => {
  assert.match(historyPage, /data-mode="current"/);
  assert.match(historyCurrent, /dataset\.mode = RANKING_MODE/);
  assert.match(historyCurrent, /textContent = 'リーダーボード'/);
});

test('summary and broadcast tables render newest rows first without changing source order', () => {
  assert.match(historyFixes, /newestFirstModes = new Set\(\['daily', 'weekly', 'monthly', 'broadcasts'\]\)/);
  assert.match(historyFixes, /const tableRows = newestFirstModes\.has\(mode\) && !append/);
  assert.match(historyFixes, /renderTable\(tableRows, mode, append\)/);
});
