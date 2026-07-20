import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(
  new URL('../../database/facts-migrations/019_d1_budget_indexes.sql', import.meta.url),
  'utf8',
);
const playback = readFileSync(
  new URL('../../site/functions/lib/primary-playback.js', import.meta.url),
  'utf8',
);

test('primary playback has a source-prefixed descending lookup index', () => {
  assert.match(
    migration,
    /idx_sh_minute_facts_source_minute_desc\s*\nON sh_minute_facts\(source_code, minute_at DESC, id DESC\)/,
  );
  assert.match(playback, /WHERE f\.source_code=1\s*\n\s*ORDER BY f\.minute_at DESC,f\.id DESC/);
});
