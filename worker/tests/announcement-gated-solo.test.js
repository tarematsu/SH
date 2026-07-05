import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { shouldProbeSolo } from '../src/cloud-host-monitor.js';
import { createStationheadTrafficGuard } from '../src/stationhead-traffic-guard.js';

function statementResult(row, calls) {
  return {
    bind(...binds) {
      calls.push(binds);
      return this;
    },
    async first() {
      return row;
    }
  };
}

test('official announcement window starts ten minutes before the scheduled time', () => {
  const config = JSON.parse(readFileSync(
    new URL('../wrangler.jsonc', import.meta.url),
    'utf8'
  ));
  assert.equal(config.vars.OFFICIAL_NEWS_EARLY_WINDOW_MS, 10 * 60_000);
});

test('idle solo monitor only runs inside an official announcement window', async () => {
  const calls = [];
  const config = {
    officialEarlyWindowMs: 10 * 60_000,
    officialLateWindowMs: 90 * 60_000
  };
  const now = Date.parse('2026-07-06T12:00:00Z');
  const env = {
    DB: {
      prepare(sql) {
        assert.match(sql, /sh_official_news_announcements/);
        return statementResult({ due: 1 }, calls);
      }
    }
  };

  assert.equal(await shouldProbeSolo(env, config, {
    phase: 'idle',
    sessionId: null
  }, now), true);
  assert.deepEqual(calls[0], [
    now - 90 * 60_000,
    now + 10 * 60_000
  ]);
});

test('active and provisional sessions continue without requiring another announcement lookup', async () => {
  const env = {
    DB: {
      prepare() {
        throw new Error('announcement lookup must not run for an active session');
      }
    }
  };
  const config = {
    officialEarlyWindowMs: 10 * 60_000,
    officialLateWindowMs: 90 * 60_000
  };

  assert.equal(await shouldProbeSolo(env, config, {
    phase: 'active',
    sessionId: 42
  }), true);
  assert.equal(await shouldProbeSolo(env, config, {
    phase: 'provisional',
    sessionId: 43
  }), true);
});

test('announcement-free idle state skips the solo endpoint', async () => {
  const config = {
    officialEarlyWindowMs: 10 * 60_000,
    officialLateWindowMs: 90 * 60_000
  };
  const env = {
    DB: {
      prepare() {
        return statementResult(null, []);
      }
    }
  };
  assert.equal(await shouldProbeSolo(env, config, {
    phase: 'idle',
    sessionId: null
  }), false);
});

test('Stationhead guest 404 code 1001 becomes a cached idle response', async () => {
  let requests = 0;
  const nativeFetch = async () => {
    requests += 1;
    return Response.json({
      error: {
        status: '404',
        code: '1001',
        detail: 'Not in database'
      }
    }, { status: 404 });
  };
  const guarded = createStationheadTrafficGuard(nativeFetch, () => 60_000);
  const url = 'https://production1.stationhead.com/station/handle/sakurazaka46jp/guest';
  const init = {
    method: 'POST',
    headers: {
      authorization: 'Bearer token',
      'sth-device-uid': 'device'
    },
    body: '{}'
  };

  const first = await guarded(url, init);
  const second = await guarded(url, init);

  assert.equal(first.status, 200);
  assert.equal(first.headers.get('x-stationhead-broadcast-state'), 'idle');
  assert.deepEqual(await first.json(), {});
  assert.equal(second.status, 200);
  assert.equal(requests, 1);
});
