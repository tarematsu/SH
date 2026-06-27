import { onRequestPost as saveLeaderboard } from '../../site/functions/api/leaderboard-ingest.js';
import { positiveNumber as positive } from './shared.js';

const SOURCE_URL = 'https://www.stationhead.com/on/api/weeklyleaderboard';
const SOURCE = 'stationhead_official_cloud';

function jstParts(now = Date.now()) {
  const date = new Date(now + 9 * 3600000);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    weekday: date.getUTCDay(),
    hour: date.getUTCHours(),
  };
}

function rankingDate(now = Date.now()) {
  const date = new Date(now + 9 * 3600000);
  const daysSinceMonday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - daysSinceMonday);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function insideWindow(env, now) {
  const parts = jstParts(now);
  const mondayStart = Number(env.WEEKLY_LEADERBOARD_START_HOUR_JST ?? 18);
  const tuesdayEnd = Number(env.WEEKLY_LEADERBOARD_END_HOUR_JST ?? 2);
  return (parts.weekday === 1 && parts.hour >= mondayStart)
    || (parts.weekday === 2 && parts.hour < tuesdayEnd);
}

async function session(env) {
  return env.DB.prepare(`SELECT auth_token,device_uid FROM sh_worker_collector_state
    WHERE id='stationhead'`).first();
}

function normalizeAccounts(payload) {
  if (!Array.isArray(payload?.accounts)) {
    const message = payload?.error?.title || payload?.error?.detail || 'accounts array missing';
    throw new Error(`official leaderboard unavailable: ${message}`);
  }
  const seen = new Set();
  return payload.accounts.map((account, index) => ({
    rank: index + 1,
    account_id: Number(account?.id) || null,
    handle: String(account?.handle || '').trim(),
    leaderboard_movement: account?.leaderboard_movement ?? null,
    is_broadcasting: Boolean(account?.station?.is_broadcasting),
    station_status: account?.station?.status ?? null,
    thumbnail_url: account?.thumbnail?.url ?? null,
    badges: Array.isArray(account?.badges) ? account.badges : [],
    raw: account,
  })).filter((account) => {
    if (!account.handle) return false;
    const key = account.handle.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function sha256(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(bytes)].map((part) => part.toString(16).padStart(2, '0')).join('');
}

async function shouldCheck(env, date, now) {
  const intervalMs = positive(env.WEEKLY_LEADERBOARD_CHECK_MINUTES, 15) * 60000;
  try {
    const row = await env.DB.prepare(`SELECT fetched_at,status FROM sh_leaderboard_fetches
      WHERE ranking_date=? AND source=? LIMIT 1`).bind(date, SOURCE).first();
    return !row?.fetched_at || now - Number(row.fetched_at) >= intervalMs;
  } catch (error) {
    if (/no such table/i.test(String(error?.message || ''))) return false;
    throw error;
  }
}

async function recordFailure(env, date, now, error) {
  try {
    await env.DB.prepare(`INSERT INTO sh_leaderboard_fetches (
        ranking_date,fetched_at,source,source_hash,row_count,status,raw_json
      ) VALUES (?,?,?,NULL,0,'error',?)
      ON CONFLICT(ranking_date,source) DO UPDATE SET
        fetched_at=excluded.fetched_at,status='error',raw_json=excluded.raw_json`)
      .bind(date, now, SOURCE, JSON.stringify({ error: String(error?.message || error).slice(0, 1000) })).run();
  } catch (writeError) {
    if (!/no such table/i.test(String(writeError?.message || ''))) console.error(writeError);
  }
}

async function fetchLeaderboard(env, now) {
  const auth = await session(env);
  const headers = {
    accept: 'application/json',
    'user-agent': 'stationhead-monitor/cloud-weekly-leaderboard',
    'app-platform': 'web',
    'app-version': env.STATIONHEAD_APP_VERSION || '1.0.0',
    origin: 'https://www.stationhead.com',
    referer: 'https://www.stationhead.com/',
  };
  if (auth?.auth_token) headers.authorization = `Bearer ${auth.auth_token}`;
  if (auth?.device_uid) headers['sth-device-uid'] = auth.device_uid;

  const response = await fetch(`${SOURCE_URL}?_=${now}`, {
    headers,
    cache: 'no-store',
    signal: AbortSignal.timeout(Math.min(positive(env.REQUEST_TIMEOUT_MS, 20000), 30000)),
  });
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); }
  catch { throw new Error(`leaderboard non-JSON ${response.status}: ${text.slice(0, 200)}`); }
  if (!response.ok) {
    throw new Error(`leaderboard HTTP ${response.status}: ${payload?.error?.title || text.slice(0, 200)}`);
  }
  return { payload, accounts: normalizeAccounts(payload) };
}

async function ingest(env, date, now, accounts, sourceHash) {
  const secret = env.INGEST_SECRET || 'worker-internal-ingest';
  const request = new Request('https://worker.internal/leaderboard-ingest', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${secret}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      observed_at: now,
      ranking_date: date,
      ranking_type: '週間チャンネル順位',
      source: SOURCE,
      source_hash: sourceHash,
      collector_id: 'cloudflare-worker',
      collector_kind: 'cloud',
      source_priority: 100,
      accounts,
    }),
  });
  const response = await saveLeaderboard({ request, env: { DB: env.DB, INGEST_SECRET: secret } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok) {
    throw new Error(`leaderboard ingest ${response.status}: ${JSON.stringify(payload).slice(0, 500)}`);
  }
  return payload;
}

export async function runCloudWeeklyLeaderboard(env) {
  if (!env.DB || String(env.WEEKLY_LEADERBOARD_ENABLED ?? 'true').toLowerCase() !== 'true') return;
  const now = Date.now();
  if (!insideWindow(env, now)) return;
  const date = rankingDate(now);
  if (!await shouldCheck(env, date, now)) return;

  try {
    const { accounts } = await fetchLeaderboard(env, now);
    const minimum = positive(env.WEEKLY_LEADERBOARD_MIN_ACCOUNTS, 20);
    if (accounts.length < minimum) throw new Error(`leaderboard incomplete: ${accounts.length} accounts`);
    const sourceHash = await sha256(accounts.map((account) => ({
      rank: account.rank,
      account_id: account.account_id,
      handle: account.handle,
      movement: account.leaderboard_movement,
    })));
    const previous = await env.DB.prepare(`SELECT source_hash,status FROM sh_leaderboard_fetches
      WHERE ranking_date=? AND source=? LIMIT 1`).bind(date, SOURCE).first().catch(() => null);
    if (previous?.status === 'saved' && previous?.source_hash === sourceHash) {
      await env.DB.prepare(`UPDATE sh_leaderboard_fetches SET fetched_at=?
        WHERE ranking_date=? AND source=?`).bind(now, date, SOURCE).run();
      return;
    }
    const result = await ingest(env, date, now, accounts, sourceHash);
    console.log(JSON.stringify({ event: 'cloud_weekly_leaderboard_saved', date, rows: result.rows }));
  } catch (error) {
    await recordFailure(env, date, now, error);
    console.warn(JSON.stringify({ event: 'cloud_weekly_leaderboard_failed', error: String(error?.message || error) }));
  }
}
