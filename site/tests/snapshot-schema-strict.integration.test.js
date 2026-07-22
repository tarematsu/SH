import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { ingestInternal as ingestPost } from '../functions/lib/ingest.js';
import { FakeD1Database, responseJson } from './helpers/fake-d1.js';

function snapshotRequest() {
  return new Request('https://worker.internal/ingest', {
    method: 'POST',
    headers: {
      authorization: 'Bearer test-key',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      type: 'snapshot',
      collector_id: 'cloudflare-worker',
      observed_at: 1_751_500_300_000,
      data: {
        channel_id: 1,
        station_id: 2,
        listener_count: 10,
        total_listens: 1000,
        current_stream_count: 1000,
      },
    }),
  });
}

test('snapshot schema errors are surfaced instead of invoking a legacy writer', async () => {
  const db = new FakeD1Database().route(
    'first',
    /FROM sh_snapshot_current/,
    () => { throw new Error('no such column: last_stream_count'); },
  );

  const response = await ingestPost({
    request: snapshotRequest(),
    env: { DB: db, INGEST_SECRET: 'test-key' },
  });
  const body = await responseJson(response);

  assert.equal(response.status, 500);
  assert.equal(body.ok, false);
  assert.match(body.error, /last_stream_count/);
  assert.equal(db.callsMatching(/UPDATE sh_channel_snapshots/, 'run').length, 0);
});

test('active ingest source has no schema compatibility fallback', () => {
  const source = readFileSync(new URL('../functions/lib/ingest.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /isPendingStreamSchemaError|ingest-legacy|ingest-core/);
});
