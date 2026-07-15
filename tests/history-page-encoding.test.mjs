import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const historyHtml = readFileSync(new URL('../site/public/history/index.html', import.meta.url), 'utf8');

test('history page remains valid UTF-8 HTML instead of byte-pair mojibake', () => {
  assert.match(historyHtml, /^<!doctype html>\s*<html lang="ja">/i);
  assert.match(historyHtml, /<meta charset="utf-8">/i);
  assert.match(historyHtml, /<h1>過去データ<\/h1>/);
  assert.match(historyHtml, /data-mode="tracks">再生曲<\/button>/);
  assert.match(historyHtml, /src="\/history\/history-main\.js"/);
  assert.doesNotMatch(historyHtml, /history-copy-fixes\.js/);
  assert.doesNotMatch(historyHtml, /[㰀-㿿]{3,}/u);
  assert.doesNotMatch(historyHtml, /\uFFFD/u);
});
