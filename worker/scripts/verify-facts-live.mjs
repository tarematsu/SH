import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const workerRoot = resolve(import.meta.dirname, '..');
const repositoryRoot = resolve(workerRoot, '..');
const outputPath = resolve(repositoryRoot, 'database/facts-live-verification.json');
const databaseName = process.env.FACTS_DATABASE_NAME || 'Stationhead-DB';
const attempts = Math.max(1, Math.min(10, Number(process.env.FACTS_VERIFY_ATTEMPTS || 5)));
const delayMs = Math.max(5_000, Number(process.env.FACTS_VERIFY_DELAY_MS || 20_000));
const freshnessMs = Math.max(120_000, Number(process.env.FACTS_VERIFY_FRESHNESS_MS || 15 * 60_000));

function wrangler(args) {
  return execFileSync('npx', ['wrangler', ...args], {
    cwd: workerRoot,
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

function parseJsonOutput(output) {
  const text = String(output || '').trim();
  const starts = [text.indexOf('['), text.indexOf('{')].filter((index) => index >= 0);
  if (!starts.length) throw new Error(`Wrangler did not return JSON: ${text.slice(0, 500)}`);
  return JSON.parse(text.slice(Math.min(...starts)));
}

function firstResult(payload) {
  const containers = Array.isArray(payload) ? payload : [payload];
  for (const container of containers) {
    const rows = container?.results || container?.result?.[0]?.results || container?.result?.results;
    if (Array.isArray(rows) && rows.length) return rows[0];
  }
  return null;
}

function writeStatus(status) {
  mkdirSync(resolve(repositoryRoot, 'database'), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(status, null, 2)}\n`);
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

let last = null;
for (let attempt = 1; attempt <= attempts; attempt += 1) {
  try {
    const payload = parseJsonOutput(wrangler([
      'd1', 'execute', databaseName,
      '--remote', '--yes', '--json',
      '--command', `SELECT
        COUNT(*) AS fact_count,
        MAX(observed_at) AS last_observed_at,
        MAX(minute_at) AS last_minute_at,
        SUM(CASE WHEN source='live_collector' THEN 1 ELSE 0 END) AS live_fact_count
      FROM sh_minute_facts`,
    ]));
    const row = firstResult(payload) || {};
    const now = Date.now();
    last = {
      result: 'pending',
      database_name: databaseName,
      attempt,
      fact_count: Number(row.fact_count || 0),
      live_fact_count: Number(row.live_fact_count || 0),
      last_observed_at: Number(row.last_observed_at || 0) || null,
      last_minute_at: Number(row.last_minute_at || 0) || null,
      checked_at: new Date(now).toISOString(),
    };
    const recent = last.last_observed_at != null && now - last.last_observed_at <= freshnessMs;
    if (last.live_fact_count > 0 && recent) {
      last.result = 'success';
      writeStatus(last);
      console.log(JSON.stringify(last));
      process.exit(0);
    }
  } catch (error) {
    last = {
      result: 'query-failed',
      database_name: databaseName,
      attempt,
      error: String(error?.message || error).slice(0, 1000),
      checked_at: new Date().toISOString(),
    };
  }
  writeStatus(last);
  if (attempt < attempts) await sleep(delayMs);
}

writeStatus({ ...last, result: last?.result === 'query-failed' ? 'query-failed' : 'live-fact-not-observed' });
throw new Error(`Live minute fact verification failed: ${JSON.stringify(last)}`);
