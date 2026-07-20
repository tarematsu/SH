import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../scripts/deploy-ingest.mjs', import.meta.url), 'utf8');

test('ingest deployment verifies the new comments consumer and rolls back safely', () => {
  assert.match(source, /runWrangler\(\['deploy', '--config', 'wrangler\.ingest\.jsonc'\]\)/);
  assert.match(source, /pauseQueue\(queue\)/);
  assert.match(source, /removeConsumer\(queue, retiredScript\)/);
  assert.match(source, /restoreConsumer\(\{ queue, oldScript: retiredScript, deadLetterQueue \}\)/);
  assert.match(source, /resumeQueue\(queue\)/);
  assert.match(source, /retired comments consumer still attached/);
});
