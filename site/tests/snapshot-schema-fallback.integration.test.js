import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isPendingStreamSchemaError,
  onRequestPost as ingestPost,
} from '../functions/api/ingest.js';
import { FakeD1Database, responseJson } from './helpers/fake-d1.js';

function snapshotRequest() {
  return new Request('https://collector.test/api/ingest', {
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

test('recognizes only stream-continuity schema gaps', () => {
  assert.equal(isPendingStreamSchemaError(new Error('no such column: last_stream_count')), true);
  assert.equal(isPendingStreamSchemaError(new Error('table sh_channel_snapshots has no column named validated_stream_count')), true);
  assert.equal(isPendingStreamSchemaError(new Error('no such table: unrelated')), false);
});

test('snapshot ingest falls back to the legacy writer while migration is pending', async () => {
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

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.type, 'snapshot');
  assert.equal(body.accepted, true);
  assert.equal(db.callsMatching(/UPDATE sh_channel_snapshots/, 'run').length, 1);
});
