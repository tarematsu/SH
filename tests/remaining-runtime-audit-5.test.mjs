import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('broadcast comparison reuses formatters and skips unchanged DOM writes', () => {
  const source = readFileSync(
    new URL('../site/public/history/history-broadcasts.js', import.meta.url),
    'utf8',
  );
  assert.match(source, /const numberFormatter = new Intl\.NumberFormat/);
  assert.match(source, /const eventDateFormatter = new Intl\.DateTimeFormat/);
  assert.match(source, /function setTextIfChanged/);
  assert.match(source, /function setHtmlIfChanged/);
  assert.match(source, /broadcast-series:v3:/);
  assert.doesNotMatch(source, /toLocaleString\(/);
  assert.doesNotMatch(source, /toLocaleDateString\(/);
});
