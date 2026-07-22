import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

import { apiCatalog, onRequest as catalogRequest } from '../functions/api/index.js';
import {
  minuteTaskHealth,
  onRequest as minuteHealthRequest,
  readMinuteHealth,
} from '../functions/api/health/minute.js';
import {
  onRequest as otherHealthRequest,
  readOtherHealth,
} from '../functions/api/health/other.js';
import {
  onRequest as sakurazakaHealthRequest,
  readSakurazakaHealth,
} from '../functions/api/health/sakurazaka46jp.js';

const NOW = 1_700_000_000_000;
const CANONICAL_PATHS = [
  '/api/health',
  '/api/health/minute',
  '/api/health/other',
  '/api/health/sakurazaka46jp',
  '/api/dashboard',
  '/api/history',
  '/api/track-history',
  '/api/sakurazaka46jp',
  '/api/host-history',
];

function runtimeRow(taskName, overrides = {}) {
  return {
    task_name: taskName,
    last_started_at: NOW - 60_000,
    last_success_at: NOW - 60_000,
    last_failure_at: null,
    last_duration_ms: 25,
    last_error: null,
    runs_total: 10,
    succeeded_total: 10,
    failed_total: 0,
    processed_total: 5,
    job_failures_total: 0,
    last_processed_count: 1,
    last_failed_count: 0,
    pending_count: 0,
    processing_count: 0,
    dead_count: 0,
    oldest_pending_minute: null,
    updated_at: NOW - 60_000,
    ...overrides,
  };
}

function minuteDb(rows) {
  return {
    prepare(sql) {
      assert.match(sql, /sh_minute_fact_runtime_state/);
      return { async all() { return { results: rows }; } };
    },
  };
}

function otherDb() {
  return {
    prepare(sql) {
      const statement = {
        args: [],
        bind(...args) {
          this.args = args;
          return this;
        },
        async first() {
          if (sql.includes('FROM sh_collector_status')) {
            assert.equal(this.args[0], 'other-cron');
            return {
              status: 'ok',
              last_attempt_at: NOW - 60_000,
              last_success_at: NOW - 60_000,
              last_error: null,
            };
          }
          if (sql.includes('sh_official_news_monitor_state')) {
            return {
              last_check_at: NOW - 60_000,
              last_success_at: NOW - 60_000,
              last_error: null,
              upcoming_count: 2,
              active_count: 1,
            };
          }
          if (sql.includes('sh_cloud_host_monitor_state')) {
            assert.equal(this.args[0], 'solo:sakurazaka46jp');
            return {
              phase: 'idle',
              session_id: null,
              station_id: null,
              last_success_at: NOW - 60_000,
              last_error: null,
              updated_at: NOW - 60_000,
            };
          }
          throw new Error(`unexpected health SQL: ${sql}`);
        },
      };
      return statement;
    },
  };
}

async function withFixedNow(action) {
  const realDateNow = Date.now;
  Date.now = () => NOW;
  try {
    return await action();
  } finally {
    Date.now = realDateNow;
  }
}

test('Pages API catalog exposes exactly the canonical routes without Worker URLs', async () => {
  const catalog = apiCatalog(NOW);
  assert.equal(catalog.gateway, 'cloudflare-pages');
  assert.equal(catalog.contract_version, 3);
  assert.equal(catalog.worker_urls_public, false);
  assert.equal('compatibility' in catalog, false);
  assert.equal('retired' in catalog, false);
  const paths = Object.values(catalog.groups).flat().map(({ path }) => path);
  assert.deepEqual(paths, CANONICAL_PATHS);
  assert.equal(new Set(paths).size, paths.length);

  const response = await catalogRequest({ request: new Request('https://example.com/api') });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).service, 'stationhead-pages-api');

  const rejected = await catalogRequest({ request: new Request('https://example.com/api', { method: 'POST' }) });
  assert.equal(rejected.status, 405);
  assert.equal(rejected.headers.get('allow'), 'GET');
});

test('Pages minute health reads all active tasks and rejects unhealthy task state', async () => {
  const rows = ['derive', 'recovery', 'rebuild', 'sync'].map((task) => runtimeRow(task));
  const payload = await readMinuteHealth({ MINUTE_DB: minuteDb(rows) }, NOW);
  assert.equal(payload.ok, true);
  assert.equal(payload.tasks.length, 4);
  assert.equal(payload.tasks.every(({ ok }) => ok), true);

  const unhealthy = minuteTaskHealth(runtimeRow('derive', { dead_count: 1 }), NOW, {});
  assert.equal(unhealthy.ok, false);
  assert.equal(unhealthy.dead_count, 1);

  const response = await withFixedNow(() => minuteHealthRequest({
    request: new Request('https://example.com/api/health/minute'),
    env: { MINUTE_DB: minuteDb(rows) },
  }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('Pages other health is scoped to the runtime orchestrator', async () => {
  const env = { OTHER_DB: otherDb() };
  const payload = await readOtherHealth(env, NOW);
  assert.equal(payload.ok, true);
  assert.equal(payload.components.runtime.ok, true);
  assert.deepEqual(payload.services, ['sh-runtime-orchestrator']);

  const response = await withFixedNow(() => otherHealthRequest({
    request: new Request('https://example.com/api/health/other'),
    env,
  }));
  assert.equal(response.status, 200);
});

test('Pages Sakurazaka health combines official news and solo monitor state', async () => {
  const env = { OTHER_DB: otherDb(), SOLO_BROADCAST_HANDLE: 'sakurazaka46jp' };
  const payload = await readSakurazakaHealth(env, NOW);
  assert.equal(payload.ok, true);
  assert.equal(payload.components.official_news.upcoming_count, 2);
  assert.equal(payload.components.solo_monitor.phase, 'idle');
  assert.deepEqual(payload.services, ['sh-sakurazaka46jp']);

  const response = await withFixedNow(() => sakurazakaHealthRequest({
    request: new Request('https://example.com/api/health/sakurazaka46jp'),
    env,
  }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).gateway, 'cloudflare-pages');
});

test('all active Workers disable workers.dev and preview URLs', () => {
  const configs = [
    '../../worker/wrangler.sakurazaka46jp.jsonc',
    '../../worker/wrangler.runtime.jsonc',
  ].map((path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')));

  for (const config of configs) {
    assert.equal(config.workers_dev, false, `${config.name} must not expose workers.dev`);
    assert.equal(config.preview_urls, false, `${config.name} must not expose preview URLs`);
    assert.equal('route' in config || 'routes' in config, false, `${config.name} must remain scheduled/Queue-only`);
  }

  const pages = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  assert.deepEqual(pages.d1_databases.map(({ binding }) => binding), ['DB', 'MINUTE_DB', 'OTHER_DB']);

  for (const path of [
    '../functions/api/index.js',
    '../functions/api/health.js',
    '../functions/api/health/minute.js',
    '../functions/api/health/other.js',
    '../functions/api/health/sakurazaka46jp.js',
    '../functions/api/dashboard.js',
    '../functions/api/track-history.js',
    '../functions/api/sakurazaka46jp.js',
  ]) {
    assert.equal(existsSync(new URL(path, import.meta.url)), true, `${path} must exist`);
  }
});
