import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { shouldProbeSolo } from '../src/cloud-host-monitor.js';
import { createShTrafficGuard } from '../src/sh-traffic-guard.js';

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

function workerConfig() {
  return JSON.parse(readFileSync(
    new URL('../wrangler.jsonc', import.meta.url),
    'utf8'
  ));
}

function guest404() {
  return Response.json({
    error: {
      status: '404',
      code: '1001',
      detail: 'Not in database'
    }
  }, { status: 404 });
}

const guestInit = {
  method: 'POST',
  headers: {
    authorization: 'Bearer token',
    'sth-device-uid': 'device'
  },
  body: '{}'
};

test('official announcement window starts ten minutes before the scheduled time', () => {
  assert.equal(workerConfig().vars.OFFICIAL_NEWS_EARLY_WINDOW_MS, 10 * 60_000);
});

test('official news is refreshed hourly to reduce routine official-site polling', () => {
  assert.equal(workerConfig().vars.OFFICIAL_NEWS_CHECK_INTERVAL_MS, 60 * 60_000);
});

test('generic official article rescans stay bounded while Stationhead titles remain eligible', () => {
  assert.equal(workerConfig().vars.OFFICIAL_NEWS_BODY_SCAN_COUNT, 1);
});

test('idle solo monitor only runs inside an official announcement window', async () => {
  const calls = [];
  const config = {
    officialEarlyWindowMs: 10 * 60_000,
    officialLateWindowMs: 90 * 60_000
  };
  const now = Date.parse('2026-07-06T12:00:00Z');
  const env = {
    OTHER_DB: {
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
    OTHER_DB: {
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

test('the official solo guest 404 becomes a cached idle response', async () => {
  let requests = 0;
  const guarded = createShTrafficGuard(async () => {
    requests += 1;
    return guest404();
  }, () => 60_000);
  const url = 'https://production1.stationhead.com/station/handle/sakurazaka46jp/guest';

  const first = await guarded(url, guestInit);
  const second = await guarded(url, guestInit);

  assert.equal(first.status, 200);
  assert.equal(first.headers.get('x-sh-broadcast-state'), 'idle');
  assert.deepEqual(await first.json(), {});
  assert.equal(second.status, 200);
  assert.equal(requests, 1);
});

test('an unknown guest handle keeps its 404 so configuration mistakes remain visible', async () => {
  let requests = 0;
  const guarded = createShTrafficGuard(async () => {
    requests += 1;
    return guest404();
  }, () => 60_000);
  const url = 'https://production1.stationhead.com/station/handle/sakurazaka46jp-typo/guest';

  const first = await guarded(url, guestInit);
  const second = await guarded(url, guestInit);

  assert.equal(first.status, 404);
  assert.equal(second.status, 404);
  assert.equal(requests, 2);
});
