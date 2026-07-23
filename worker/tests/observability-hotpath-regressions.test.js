import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  CLAIM_MINUTE_FACT_JOBS_SQL,
} from '../src/minute-facts-inbox.js';
import { saveMaterializedResponse } from '../src/pages-response-store.js';

const dashboardCore = readFileSync(
  new URL('../../site/functions/lib/dashboard-core.js', import.meta.url),
  'utf8',
);

test('materialized HTTP failures retain sanitized dashboard error details', async () => {
  let failure;
  try {
    await saveMaterializedResponse(
      null,
      null,
      'dashboard',
      Response.json({
        ok: false,
        error: 'DB binding missing; Bearer abcdefghijklmnopqrstuvwxyz123456',
      }, { status: 500 }),
      Date.now(),
      300,
    );
  } catch (error) {
    failure = error;
  }
  assert.match(String(failure?.message), /dashboard returned HTTP 500: DB binding missing/);
  assert.match(String(failure?.message), /Bearer \[redacted\]/);
  assert.doesNotMatch(String(failure?.message), /abcdefghijklmnopqrstuvwxyz123456/);
});

test('stale dashboard responses are explicit skips and never overwrite storage', async () => {
  let puts = 0;
  const response = Response.json({
    ok: false,
    code: 'MINUTE_FACTS_STALE',
    error: 'minute facts read model is stale',
  }, {
    status: 503,
    headers: {
      'x-dashboard-facts-stale': '1',
      'x-dashboard-facts-observed-at': '123456789',
    },
  });
  const result = await saveMaterializedResponse(
    null,
    { async put() { puts += 1; } },
    'dashboard',
    response,
    Date.now(),
    300,
  );
  assert.deepEqual(result, {
    skipped: true,
    reason: 'facts-stale',
    facts_latest_observed_at: 123456789,
  });
  assert.equal(puts, 0);
});

test('dashboard stale handling refuses a masked legacy DB before fallback execution', () => {
  const maskedDbGuard = dashboardCore.indexOf('if (!context.env?.DB)');
  const legacyFallback = dashboardCore.indexOf('dashboardFromBuddiesDb(context)', maskedDbGuard);
  assert.ok(maskedDbGuard >= 0);
  assert.ok(legacyFallback > maskedDbGuard);
  assert.match(dashboardCore, /status: 503/);
  assert.match(dashboardCore, /'x-dashboard-facts-stale': '1'/);
  assert.match(dashboardCore, /code: 'MINUTE_FACTS_STALE'/);
});

test('legacy D1 job claims use the due-first partial index', () => {
  assert.match(CLAIM_MINUTE_FACT_JOBS_SQL, /INDEXED BY idx_sh_minute_fact_jobs_pending_ready/);
  assert.match(
    CLAIM_MINUTE_FACT_JOBS_SQL,
    /ORDER BY next_attempt_at ASC,job_priority DESC,minute_at ASC,id ASC/,
  );
  assert.doesNotMatch(CLAIM_MINUTE_FACT_JOBS_SQL, /ORDER BY job_priority DESC,minute_at ASC/);
});
