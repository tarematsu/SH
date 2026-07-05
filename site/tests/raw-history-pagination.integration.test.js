import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decodeRawHistoryCursor,
  onRequestGet as rawHistoryGet,
} from '../functions/api/history-raw.js';
import { FakeD1Database, responseJson } from './helpers/fake-d1.js';

const DAY_MS = 86_400_000;

function request(query) {
  return new Request(`https://history.test/api/history?mode=raw&${query}`);
}

test('raw history cursor pagination can continue beyond the former 31-day boundary', async () => {
  const from = '2024-06-01';
  const to = '2025-06-01';
  const fromTs = Date.parse(`${from}T00:00:00+09:00`);
  const toTs = Date.parse(`${to}T00:00:00+09:00`) + DAY_MS;
  let reads = 0;
  const firstRows = Array.from({ length: 21 }, (_, index) => ({
    id: index + 1,
    observed_at: fromTs + (index + 35) * DAY_MS,
    observed_jst: new Date(fromTs + (index + 35) * DAY_MS).toISOString(),
  }));
  const db = new FakeD1Database().route('all', /FROM sh_legacy_history_rows/, () => {
    reads += 1;
    return { results: reads === 1 ? firstRows : [] };
  });

  const firstResponse = await rawHistoryGet({
    request: request(`from=${from}&to=${to}&limit=20`),
    env: { DB: db },
  });
  const firstBody = await responseJson(firstResponse);

  assert.equal(firstResponse.status, 200);
  assert.equal(firstBody.rows.length, 20);
  assert.equal(firstBody.has_more, true);
  assert.ok(firstBody.next_cursor);
  assert.deepEqual(decodeRawHistoryCursor(firstBody.next_cursor), {
    timestamp: firstRows[19].observed_at,
    id: firstRows[19].id,
  });
  assert.deepEqual(db.calls[0].params, [fromTs, toTs, 21]);
  assert.ok(firstRows[0].observed_at > fromTs + 31 * DAY_MS);

  const secondResponse = await rawHistoryGet({
    request: request(`from=${from}&to=${to}&limit=20&cursor=${encodeURIComponent(firstBody.next_cursor)}`),
    env: { DB: db },
  });
  const secondBody = await responseJson(secondResponse);

  assert.equal(secondResponse.status, 200);
  assert.equal(secondBody.rows.length, 0);
  assert.equal(secondBody.has_more, false);
  assert.deepEqual(db.calls[1].params, [
    fromTs,
    toTs,
    firstRows[19].observed_at,
    firstRows[19].observed_at,
    firstRows[19].id,
    21,
  ]);
});

test('invalid calendar dates are rejected instead of silently normalizing', async () => {
  const db = new FakeD1Database();
  const response = await rawHistoryGet({
    request: request('from=2025-02-30&to=2025-03-10'),
    env: { DB: db },
  });
  const body = await responseJson(response);

  assert.equal(response.status, 400);
  assert.match(body.error, /valid YYYY-MM-DD/);
  assert.equal(db.calls.length, 0);
});

test('reversed ranges and malformed cursors are rejected before D1 reads', async () => {
  const db = new FakeD1Database();

  const reversed = await rawHistoryGet({
    request: request('from=2025-04-01&to=2025-03-01'),
    env: { DB: db },
  });
  assert.equal(reversed.status, 400);

  const malformed = await rawHistoryGet({
    request: request('from=2025-03-01&to=2025-04-01&cursor=not-base64'),
    env: { DB: db },
  });
  assert.equal(malformed.status, 400);

  const outside = btoa(`${Date.parse('2025-05-01T00:00:00+09:00')}:10`);
  const outsideResponse = await rawHistoryGet({
    request: request(`from=2025-03-01&to=2025-04-01&cursor=${encodeURIComponent(outside)}`),
    env: { DB: db },
  });
  assert.equal(outsideResponse.status, 400);
  assert.equal(db.calls.length, 0);
});
