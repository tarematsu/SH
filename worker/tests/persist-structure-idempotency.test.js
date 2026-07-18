import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('staged structure retries do not duplicate queue snapshots', () => {
  const source = readFileSync(
    new URL('../src/persist-structure-stages.js', import.meta.url),
    'utf8',
  );

  assert.match(source, /function queueSnapshotStatement/);
  assert.match(source, /INSERT INTO sh_queue_snapshots[\s\S]*SELECT \?,\?,\?,\?,\?,\?[\s\S]*WHERE NOT EXISTS/);
  assert.match(source, /WHERE observed_at=\? AND station_id IS \? AND queue_id IS \? AND start_time IS \?/);
});
