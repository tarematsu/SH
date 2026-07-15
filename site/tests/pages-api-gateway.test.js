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

const NOW = 1_700_000_000_000;

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
            const id = this.args[0];
            if (id === 'other-cron') {
              return { status: 'ok', last_attempt_at: NOW - 60_000, last_success_at: NOW - 60_000, last_error: null };
            }
            if (id === 'buddy46-playback') {
              return { status: 'ok', last_attempt_at: NOW - 60_000, last_success_at: NOW - 60_000, last_error: null };
            }
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
            const id = this.args[0];
            if (id === 'profile:sakuramankai') {
              return {
                phase: 'idle',
                session_id: null,
                station_id: null,
                last_success_at: NOW - 60_000,
                last_error: null,
                updated_at: NOW - 60_000,
              };
            }
            if (id === 'solo:sakurazaka46jp') return null;
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

test('Pages API catalog exposes the public gateway without Worker URLs', async () => {
  const catalog = apiCatalog(NOW);
  assert.equal(catalog.gateway, 'cloudflare-pages');
  assert.equal(catalog.contract_version, 2);
  assert.equal(catalog.worker_urls_public, false);
  const paths = Object.values(catalog.groups).flat().map(({ path }) => path);
  assert.ok(paths.includes('/api/health'));
  assert.equal(paths.includes('/api/health/collector'), false);
  assert.ok(paths.includes('/api/health/minute'));
  assert.ok(paths.includes('/api/health/other'));
  assert.ok(paths.includes('/api/minute-facts/latest'));
  assert.equal(new Set(paths).size, paths.length);

  const compatibility = new Map(catalog.compatibility.map(({ path, successor }) => [path, successor]));
  assert.equal(compatibility.get('/api/health/collector'), '/api/health');

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

test('Pages other health reads scheduler, buddy, official news and cloud host state', async () => {
  const env = {
    OTHER_DB: otherDb(),
    BUDDY_PLAYBACK_ENABLED: true,
    BUDDY_PLAYBACK_ALIAS: 'buddy46',
    HOST_PROFILE_HANDLE: 'sakuramankai',
    SOLO_BROADCAST_HANDLE: 'sakurazaka46jp',
  };
  const payload = await readOtherHealth(env, NOW);
  assert.equal(payload.ok, true);
  assert.equal(payload.components.cron.ok, true);
  assert.equal(payload.components.buddy.ok, true);
  assert.equal(payload.components.official_news.upcoming_count, 2);
  assert.equal(payload.components.cloud_host.profile_phase, 'idle');

  const response = await withFixedNow(() => otherHealthRequest({
    request: new Request('https://example.com/api/health/other'),
    env,
  }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).gateway, 'cloudflare-pages');
});

test('all scheduled Workers disable workers.dev and preview URLs', () => {
  const configs = [
    '../../worker/wrangler.jsonc',
    '../../worker/wrangler.minute.jsonc',
    '../../worker/wrangler.other.jsonc',
  ].map((path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')));

  for (const config of configs) {
    assert.equal(config.workers_dev, false, `${config.name} must not expose workers.dev`);
    assert.equal(config.preview_urls, false, `${config.name} must not expose preview URLs`);
    assert.equal('route' in config || 'routes' in config, false, `${config.name} must remain scheduled/Queue-only`);
  }

  const pages = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  assert.deepEqual(pages.d1_databases.map(({ binding }) => binding), ['DB', 'MINUTE_DB', 'OTHER_DB']);
  assert.equal(pages.vars.MINUTE_DERIVE_STALE_MS, 360_000);
  assert.equal(pages.vars.OTHER_CRON_STALE_MS, 720_000);

  for (const path of [
    '../functions/api/index.js',
    '../functions/api/health/collector.js',
    '../functions/api/health/minute.js',
    '../functions/api/health/other.js',
    '../functions/api/minute-facts/latest.js',
  ]) {
    assert.equal(existsSync(new URL(path, import.meta.url)), true, `${path} must exist`);
  }
});
