import 'dotenv/config';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mode = String(process.env.COLLECTOR_MODE || 'auto').trim().toLowerCase();
const coordinationUrl = process.env.COORDINATION_URL
  || 'https://sh-monitor-collector.tarematsu.workers.dev/coordination/lease';
const checkIntervalMs = positive('FAILOVER_CHECK_INTERVAL_MS', 60000);
const graceMs = positive('FAILOVER_GRACE_MS', 180000);
const shutdownTimeoutMs = positive('FAILOVER_SHUTDOWN_TIMEOUT_MS', 15000);
const baseCollectorId = process.env.COLLECTOR_ID || os.hostname();

if (!['auto', 'active', 'standby'].includes(mode)) {
  throw new Error('COLLECTOR_MODE must be auto, active, or standby');
}

let child = null;
let stopping = false;
let checking = false;
let unreachableSince = 0;
let lastCloudHealthy = null;
let lastWarningAt = 0;

function positive(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

function log(level, message, extra = null) {
  const suffix = extra == null ? '' : ` ${JSON.stringify(extra)}`;
  console.log(`${new Date().toISOString()} ${level.toUpperCase()} ${message}${suffix}`);
}

function childCollectorId() {
  if (mode === 'active') return `${baseCollectorId}-active`;
  if (mode === 'auto') return `${baseCollectorId}-auto`;
  return `${baseCollectorId}-standby`;
}

function startCollector(reason) {
  if (child || stopping) return;
  const env = {
    ...process.env,
    COLLECTOR_ID: childCollectorId(),
    COLLECTOR_KIND: 'local',
    SOURCE_PRIORITY: mode === 'active' ? '80' : '70',
  };
  child = spawn(process.execPath, ['--import=./fetch-cache.mjs', 'collector.mjs'], {
    cwd: here,
    env,
    stdio: 'inherit',
    windowsHide: true,
  });
  log('warn', 'local collector started', { mode, reason, pid: child.pid });
  child.once('exit', (code, signal) => {
    log(code === 0 ? 'info' : 'warn', 'local collector exited', { code, signal });
    child = null;
  });
  child.once('error', (error) => {
    log('error', 'local collector child error', { error: error.message });
  });
}

async function stopCollector(reason) {
  if (!child) return;
  const target = child;
  log('info', 'stopping local collector', { reason, pid: target.pid });
  target.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise((resolve) => target.once('exit', () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), shutdownTimeoutMs)),
  ]);
  if (!exited && target.pid) {
    log('warn', 'forcing local collector shutdown', { pid: target.pid });
    target.kill('SIGKILL');
  }
}

async function cloudLease() {
  const response = await fetch(coordinationUrl, {
    headers: { accept: 'application/json' },
    cache: 'no-store',
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`coordination HTTP ${response.status}`);
  const body = await response.json();
  if (!body?.ok) throw new Error(body?.error || 'coordination response invalid');
  return body;
}

async function evaluateAutoMode() {
  if (checking || stopping) return;
  checking = true;
  try {
    const lease = await cloudLease();
    unreachableSince = 0;
    lastWarningAt = 0;
    const healthy = Boolean(lease.healthy && Number(lease.lease_until || 0) > Date.now());
    if (healthy !== lastCloudHealthy) {
      log('info', 'cloud lease state changed', {
        healthy,
        holder_id: lease.holder_id || null,
        lease_until: lease.lease_until || null,
      });
      lastCloudHealthy = healthy;
    }
    if (healthy) await stopCollector('cloud lease healthy');
    else startCollector('cloud lease expired');
  } catch (error) {
    const now = Date.now();
    if (!unreachableSince) unreachableSince = now;
    const elapsed = now - unreachableSince;
    if (!lastWarningAt || now - lastWarningAt >= 300000) {
      lastWarningAt = now;
      log('warn', 'cloud coordination unavailable', { error: error.message, elapsed_ms: elapsed });
    }
    if (elapsed >= graceMs) startCollector('coordination unavailable past grace');
  } finally {
    checking = false;
  }
}

async function run() {
  log('info', 'collector supervisor started', {
    mode,
    coordination_url: coordinationUrl,
    check_interval_ms: checkIntervalMs,
    grace_ms: graceMs,
  });

  if (mode === 'active') startCollector('active mode');
  if (mode === 'standby') log('info', 'standby mode: collector will not be started');
  if (mode === 'auto') await evaluateAutoMode();

  const timer = setInterval(() => {
    if (mode === 'auto') evaluateAutoMode().catch((error) => log('error', 'auto evaluation failed', { error: error.message }));
    if (mode === 'active' && !child) startCollector('active mode child restart');
  }, checkIntervalMs);

  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    log('info', 'collector supervisor stopping', { signal });
    await stopCollector(`supervisor ${signal}`);
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

run().catch((error) => {
  log('error', 'collector supervisor failed', { error: error.message });
  process.exitCode = 1;
});
