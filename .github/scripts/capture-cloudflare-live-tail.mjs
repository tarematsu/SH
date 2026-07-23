#!/usr/bin/env node

import assert from 'node:assert/strict';

const API_BASE = 'https://api.cloudflare.com/client/v4';
const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
const worker = process.env.LIVE_TAIL_WORKER?.trim();
const durationMs = Math.max(10_000, Number(process.env.LIVE_TAIL_SECONDS || 180) * 1000);
const probes = (process.env.LIVE_TAIL_PROBES || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const OK_OUTCOMES = new Set(['', 'ok', 'success', 'canceled', 'cancelled']);
const ERROR_OUTCOMES = new Set(['error', 'failed', 'failure', 'exception']);

export function isErrorLike(value) {
  const workers = value?.$workers && typeof value.$workers === 'object' ? value.$workers : {};
  const metadata = value?.$metadata && typeof value.$metadata === 'object' ? value.$metadata : {};
  const source = value?.source && typeof value.source === 'object' ? value.source : {};
  const workerOutcome = String(workers.outcome || '').toLowerCase();
  if (workerOutcome && !OK_OUTCOMES.has(workerOutcome)) return true;
  const level = String(metadata.level || source.level || '').toLowerCase();
  if (level === 'error' || level === 'fatal') return true;
  const sourceOutcome = String(source.outcome || '').toLowerCase();
  return Boolean(metadata.error || source.error || ERROR_OUTCOMES.has(sourceOutcome));
}

function selfTest() {
  assert.equal(isErrorLike({ $workers: { outcome: 'ok' } }), false);
  assert.equal(isErrorLike({ source: { outcome: 'success' } }), false);
  assert.equal(isErrorLike({ $workers: { outcome: 'exception' } }), true);
  assert.equal(isErrorLike({ source: { outcome: 'failure' } }), true);
  assert.equal(isErrorLike({ $metadata: { level: 'error' } }), true);
  assert.equal(isErrorLike({ source: { error: 'D1_ERROR' } }), true);
  console.log('live-tail outcome classification self-test passed');
}

if (process.argv.includes('--self-test')) {
  selfTest();
  process.exit(0);
}

if (!token || !worker) throw new Error('CLOUDFLARE_API_TOKEN and LIVE_TAIL_WORKER are required');

const headers = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/json',
  'Content-Type': 'application/json',
  'User-Agent': 'github-actions-cloudflare-live-tail',
};

async function api(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, { ...options, headers: { ...headers, ...options.headers } });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = null; }
  if (!response.ok || data?.success === false || data?.errors?.length) {
    throw new Error(`Cloudflare API ${response.status}: ${text.slice(0, 1200)}`);
  }
  return data;
}

async function accountId() {
  const override = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  if (override) return override;
  const data = await api('/accounts?per_page=50');
  const accounts = data.result || [];
  if (accounts.length !== 1) throw new Error(`Expected one account, got ${accounts.length}`);
  return accounts[0].id;
}

function sanitize(value, key = '') {
  if (value === null || value === undefined) return value;
  const lower = key.toLowerCase();
  if (['headers', 'cookies', 'authorization', 'token', 'secret'].some((name) => lower.includes(name))) {
    return '[redacted]';
  }
  if (typeof value === 'string') {
    if (lower.includes('url')) {
      try {
        const parsed = new URL(value);
        return `${parsed.protocol}//${parsed.host}${parsed.pathname}`.slice(0, 240);
      } catch {}
    }
    return value.length > 500 ? `${value.slice(0, 500)}…` : value;
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitize(item, key));
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([childKey]) => !['cf', 'requestHeaders', 'responseHeaders'].includes(childKey))
        .map(([childKey, child]) => [childKey, sanitize(child, childKey)]),
    );
  }
  return value;
}

function findNumbers(value, path = '', found = []) {
  if (!value || typeof value !== 'object') return found;
  for (const [key, child] of Object.entries(value)) {
    const next = path ? `${path}.${key}` : key;
    if (typeof child === 'number' && /cpu.*time|time.*cpu/i.test(next)) found.push([next, child]);
    else if (child && typeof child === 'object') findNumbers(child, next, found);
  }
  return found;
}

async function probeWorker(account) {
  if (!probes.length) return;
  try {
    const [accountSubdomain, scriptSubdomain] = await Promise.all([
      api(`/accounts/${account}/workers/subdomain`),
      api(`/accounts/${account}/workers/scripts/${encodeURIComponent(worker)}/subdomain`),
    ]);
    if (!scriptSubdomain.result?.enabled) {
      console.log('LIVE_TAIL_PROBE=workers.dev disabled');
      return;
    }
    const host = `${worker}.${accountSubdomain.result.subdomain}.workers.dev`;
    for (const path of probes) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const response = await fetch(`https://${host}${path}`, { redirect: 'manual' });
        console.log(`LIVE_TAIL_PROBE=${path} status=${response.status}`);
        await new Promise((resolve) => setTimeout(resolve, 750));
      }
    }
  } catch (error) {
    console.log(`LIVE_TAIL_PROBE_WARNING=${String(error.message || error).slice(0, 500)}`);
  }
}

const account = await accountId();
console.log(`LIVE_TAIL_START worker=${worker} seconds=${durationMs / 1000}`);
const prepared = await api(`/accounts/${account}/workers/observability/telemetry/live-tail`, {
  method: 'POST',
  body: JSON.stringify({ scriptId: worker }),
});
let wsUrl = prepared.result.wsUrl;
if (wsUrl.startsWith('https://')) wsUrl = `wss://${wsUrl.slice('https://'.length)}`;
if (wsUrl.startsWith('http://')) wsUrl = `ws://${wsUrl.slice('http://'.length)}`;

const socket = new WebSocket(wsUrl);
let events = 0;
let errors = 0;
let maxCpu = null;
let heartbeat;
let timer;

const finished = new Promise((resolve, reject) => {
  socket.addEventListener('open', async () => {
    console.log('LIVE_TAIL_CONNECTED=true');
    heartbeat = setInterval(() => {
      api(`/accounts/${account}/workers/observability/telemetry/live-tail/heartbeat`, {
        method: 'POST',
        body: JSON.stringify({ scriptId: worker }),
      }).catch((error) => console.log(`LIVE_TAIL_HEARTBEAT_WARNING=${String(error.message || error).slice(0, 300)}`));
    }, 25_000);
    probeWorker(account).catch(() => {});
    timer = setTimeout(() => socket.close(1000, 'diagnostic complete'), durationMs);
  });
  socket.addEventListener('message', async (message) => {
    const text = typeof message.data === 'string' ? message.data : await message.data.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 1000) }; }
    const safe = sanitize(parsed);
    const cpu = findNumbers(safe);
    for (const [, value] of cpu) maxCpu = maxCpu === null ? value : Math.max(maxCpu, value);
    if (isErrorLike(safe)) errors += 1;
    events += 1;
    console.log(`LIVE_TAIL_EVENT=${JSON.stringify(safe)}`);
    if (cpu.length) console.log(`LIVE_TAIL_CPU=${JSON.stringify(cpu)}`);
  });
  socket.addEventListener('error', (event) => reject(new Error(`Live tail WebSocket error: ${event.message || 'unknown'}`)));
  socket.addEventListener('close', () => resolve());
});

try {
  await finished;
} finally {
  clearInterval(heartbeat);
  clearTimeout(timer);
}
console.log(`LIVE_TAIL_SUMMARY worker=${worker} events=${events} error_like=${errors} max_cpu_field=${maxCpu}`);
