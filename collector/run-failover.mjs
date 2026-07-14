import 'dotenv/config';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mode = String(process.env.COLLECTOR_MODE || 'standby').trim().toLowerCase();
const graceMs = positive('FAILOVER_GRACE_MS', 180000);
const shutdownTimeoutMs = positive('FAILOVER_SHUTDOWN_TIMEOUT_MS', 15000);
const baseCollectorId = process.env.COLLECTOR_ID || os.hostname();

if (!['auto', 'active', 'standby'].includes(mode)) {
  throw new Error('COLLECTOR_MODE must be auto, active, or standby');
}

let child = null;
let stopping = false;

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

async function run() {
  log('info', 'collector supervisor started', {
    mode,
  });

  if (mode === 'active') startCollector('active mode');
  if (mode === 'standby') log('info', 'standby mode: collector will not be started');
  if (mode === 'auto') {
    log('warn', 'auto mode is deprecated because cloud lease coordination was removed; remaining in standby');
  }

  const timer = setInterval(() => {
    if (mode === 'active' && !child) startCollector('active mode child restart');
  }, graceMs);

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
