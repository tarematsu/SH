import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';

const SOURCE_URL = 'https://www.stationhead.com/on/api/weeklyleaderboard';
const STATE_FILE = path.resolve(process.cwd(), '.weekly-leaderboard-state.json');

const collectorId = process.env.COLLECTOR_ID || `${os.hostname()}-leaderboard`;
const collectorKind = process.env.COLLECTOR_KIND || 'local';
const sourcePriority = Number(process.env.SOURCE_PRIORITY || (/[-_:]active(?:$|[-_:])/i.test(collectorId) ? 80 : 70));

const config = {
  enabled: String(process.env.WEEKLY_LEADERBOARD_ENABLED ?? 'true').toLowerCase() === 'true',
  ingestUrl:
    process.env.LEADERBOARD_INGEST_URL ||
    String(process.env.INGEST_URL || '').replace(/\/api\/ingest\/?$/, '/api/leaderboard-ingest'),
  ingestSecret: process.env.INGEST_SECRET || '',
  checkIntervalMinutes: numberEnv('WEEKLY_LEADERBOARD_CHECK_MINUTES', 15),
  mondayStartHourJst: numberEnv('WEEKLY_LEADERBOARD_START_HOUR_JST', 18, true),
  tuesdayEndHourJst: numberEnv('WEEKLY_LEADERBOARD_END_HOUR_JST', 2, true),
  minimumAccounts: numberEnv('WEEKLY_LEADERBOARD_MIN_ACCOUNTS', 20),
  saveFirstValid: String(process.env.WEEKLY_LEADERBOARD_SAVE_FIRST_VALID ?? 'true').toLowerCase() === 'true',
};

function numberEnv(name, fallback, allowZero = false) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || (allowZero ? value < 0 : value <= 0)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function log(level, ...args) {
  console.log(new Date().toISOString(), level.toUpperCase(), ...args);
}

function jstParts(now = new Date()) {
  const shifted = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    date: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

function latestMondayJst(now = new Date()) {
  const shifted = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const daysSinceMonday = (shifted.getUTCDay() + 6) % 7;
  shifted.setUTCDate(shifted.getUTCDate() - daysSinceMonday);
  return [
    shifted.getUTCFullYear(),
    String(shifted.getUTCMonth() + 1).padStart(2, '0'),
    String(shifted.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

function insideUpdateWindow(now = new Date()) {
  const p = jstParts(now);
  return (
    (p.weekday === 1 && p.hour >= config.mondayStartHourJst) ||
    (p.weekday === 2 && p.hour < config.tuesdayEndHourJst)
  );
}

async function loadState() {
  try {
    return JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') log('warn', 'state read failed', error.message);
    return {};
  }
}

async function saveState(state) {
  await fs.writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

function normalizeAccounts(payload) {
  if (!Array.isArray(payload?.accounts)) {
    const message = payload?.error?.title || payload?.error?.detail || 'accounts array missing';
    throw new Error(`official leaderboard unavailable: ${message}`);
  }

  const seen = new Set();
  return payload.accounts
    .map((account, index) => ({
      rank: index + 1,
      account_id: Number(account?.id) || null,
      handle: String(account?.handle || '').trim(),
      leaderboard_movement: account?.leaderboard_movement ?? null,
      is_broadcasting: Boolean(account?.station?.is_broadcasting),
      station_status: account?.station?.status ?? null,
      thumbnail_url: account?.thumbnail?.url ?? null,
      badges: Array.isArray(account?.badges) ? account.badges : [],
      raw: account,
    }))
    .filter((account) => {
      if (!account.handle) return false;
      const key = account.handle.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function leaderboardHash(accounts) {
  const stable = accounts.map((account) => ({
    rank: account.rank,
    account_id: account.account_id,
    handle: account.handle,
    movement: account.leaderboard_movement,
  }));
  return crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

async function fetchLeaderboard() {
  const response = await fetch(`${SOURCE_URL}?_=${Date.now()}`, {
    headers: {
      accept: 'application/json',
      'user-agent': 'stationhead-monitor/weekly-leaderboard',
      ...((process.env.STATIONHEAD_AUTH_TOKEN || process.env.SH_AUTH_TOKEN) ? { authorization: `Bearer ${process.env.STATIONHEAD_AUTH_TOKEN || process.env.SH_AUTH_TOKEN}` } : {}),
      ...((process.env.STATIONHEAD_DEVICE_UID || process.env.SH_DEVICE_UID) ? { 'sth-device-uid': process.env.STATIONHEAD_DEVICE_UID || process.env.SH_DEVICE_UID } : {}),
      'app-platform': 'web',
      'app-version': process.env.STATIONHEAD_APP_VERSION || process.env.SH_APP_VERSION || '1.0.0',
      origin: 'https://www.stationhead.com',
      referer: 'https://www.stationhead.com/',
    },
    cache: 'no-store',
    signal: AbortSignal.timeout(30_000),
  });

  const responseText = await response.text();
  let payload;
  try {
    payload = JSON.parse(responseText);
  } catch {
    throw new Error(`non-JSON response ${response.status}: ${responseText.slice(0, 200)}`);
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${payload?.error?.title || responseText.slice(0, 200)}`);
  }

  const accounts = normalizeAccounts(payload);
  if (accounts.length < config.minimumAccounts) {
    throw new Error(`leaderboard looks incomplete: ${accounts.length} accounts`);
  }
  return { accounts, payload };
}

async function ingestLeaderboard({ accounts, sourceHash, rankingDate, observedAt }) {
  if (!config.ingestUrl || !config.ingestSecret) {
    throw new Error('LEADERBOARD_INGEST_URL/INGEST_URL and INGEST_SECRET are required');
  }

  const response = await fetch(config.ingestUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.ingestSecret}`,
    },
    body: JSON.stringify({
      observed_at: observedAt,
      ranking_date: rankingDate,
      ranking_type: '週間チャンネル順位',
      source: 'stationhead_official',
      source_hash: sourceHash,
      collector_id: collectorId,
      collector_kind: collectorKind,
      source_priority: sourcePriority,
      accounts,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`leaderboard ingest failed ${response.status}: ${responseText.slice(0, 500)}`);
  }
  return responseText ? JSON.parse(responseText) : {};
}

async function checkOnce({ forceSave = false, baselineOnly = false } = {}) {
  const observedAt = Date.now();
  const state = await loadState();
  const { accounts } = await fetchLeaderboard();
  const sourceHash = leaderboardHash(accounts);
  const rankingDate = latestMondayJst(new Date(observedAt));

  const changed = sourceHash !== state.last_seen_hash;
  log('info', `leaderboard fetched accounts=${accounts.length} week=${rankingDate} changed=${changed}`);

  state.last_checked_at = observedAt;
  state.last_seen_hash = sourceHash;
  state.last_seen_count = accounts.length;

  if (baselineOnly) {
    state.baseline_at = observedAt;
    await saveState(state);
    log('info', 'baseline saved without D1 ingest');
    return;
  }

  const shouldSave =
    forceSave ||
    (changed && (state.last_saved_hash || config.saveFirstValid));

  if (!shouldSave) {
    await saveState(state);
    log('info', state.last_saved_hash ? 'no leaderboard change' : 'first valid response kept as baseline');
    return;
  }

  const result = await ingestLeaderboard({
    accounts,
    sourceHash,
    rankingDate,
    observedAt,
  });

  state.last_saved_hash = sourceHash;
  state.last_saved_week = rankingDate;
  state.last_saved_at = observedAt;
  state.last_saved_count = accounts.length;
  await saveState(state);

  log('info', `leaderboard saved week=${rankingDate} rows=${result.rows ?? accounts.length}`);
}

async function daemon() {
  if (!config.enabled) {
    log('info', 'weekly leaderboard collector disabled');
    return;
  }

  log(
    'info',
    `weekly leaderboard collector started window=Mon ${config.mondayStartHourJst}:00-Tue ${config.tuesdayEndHourJst}:00 JST`,
  );

  while (true) {
    try {
      const state = await loadState();
      const due =
        !state.last_checked_at ||
        Date.now() - Number(state.last_checked_at) >= config.checkIntervalMinutes * 60_000;

      if (insideUpdateWindow() && due) {
        await checkOnce();
      }
    } catch (error) {
      log('warn', error.message);
      const state = await loadState();
      state.last_checked_at = Date.now();
      state.last_error = error.message;
      await saveState(state);
    }

    await new Promise((resolve) => setTimeout(resolve, 60_000));
  }
}

const args = new Set(process.argv.slice(2));

if (args.has('--once')) {
  checkOnce({
    forceSave: args.has('--save'),
    baselineOnly: args.has('--baseline'),
  }).catch((error) => {
    log('error', error.message);
    process.exitCode = 1;
  });
} else {
  daemon().catch((error) => {
    log('error', error.message);
    process.exitCode = 1;
  });
}
