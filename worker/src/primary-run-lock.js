// Cross-tick mutex for the buddies worker's primary collection cycle.
//
// main-scheduler.js's flight de-dup (primaryFlightsByContext) only prevents
// re-entrancy within a single request context; Cloudflare hands every cron
// invocation a fresh context, so a slow collection run (close to the 55s
// watchdog) can still overlap with the next minute's independent run. This
// claims a short-lived D1 lease before starting collection so an overlapping
// tick skips instead of racing the still-running one. The lease is only
// released on a clean finish; a timed-out/crashed run lets it expire on its
// own TTL rather than releasing early, which would just let the very next
// tick start against a collection that may still be running in the
// background (Cloudflare aborting our await doesn't forcibly stop it).
const SCOPE = 'stationhead-primary-run';
const DEFAULT_TTL_MS = 70_000;
const MIN_TTL_MS = 30_000;
const MAX_TTL_MS = 180_000;

export const PRIMARY_RUN_LOCK_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS sh_primary_run_lock (
  scope TEXT PRIMARY KEY,
  holder_id TEXT NOT NULL,
  claimed_at INTEGER NOT NULL,
  lease_until INTEGER NOT NULL
)`;

let primaryRunLockSchemaReady = false;

async function ensurePrimaryRunLockSchema(db) {
  if (primaryRunLockSchemaReady) return;
  await db.prepare(PRIMARY_RUN_LOCK_SCHEMA_SQL).run();
  primaryRunLockSchemaReady = true;
}

const CLAIM_SQL = `INSERT INTO sh_primary_run_lock (scope,holder_id,claimed_at,lease_until)
  VALUES (?,?,?,?)
  ON CONFLICT(scope) DO UPDATE SET
    holder_id=excluded.holder_id,claimed_at=excluded.claimed_at,lease_until=excluded.lease_until
  WHERE sh_primary_run_lock.lease_until<?
  RETURNING holder_id`;

const RELEASE_SQL = `UPDATE sh_primary_run_lock SET lease_until=? WHERE scope=? AND holder_id=?`;
const STATUS_SQL = `SELECT lease_until FROM sh_primary_run_lock WHERE scope=?`;

function ttlMs(env = {}) {
  const configured = Number(env.PRIMARY_RUN_LOCK_TTL_MS ?? DEFAULT_TTL_MS);
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_TTL_MS;
  return Math.max(MIN_TTL_MS, Math.min(MAX_TTL_MS, Math.trunc(configured)));
}

export function primaryRunLockEnabled(env = {}) {
  const configured = env.PRIMARY_RUN_LOCK_ENABLED;
  if (configured == null || configured === '') return true;
  return !['0', 'false', 'no', 'off'].includes(String(configured).trim().toLowerCase());
}

function noSuchTable(error) {
  return /no such table/i.test(String(error?.message || ''));
}

// Fails open (treats the run as claimed) on any error or when disabled or
// when there's no DB binding at all, so a lock-table problem can never block
// the primary collection cycle itself -- the worst case reverts to today's
// unguarded overlap, not a stuck collector.
export async function claimPrimaryRunLock(env, holderId, now = Date.now()) {
  if (!env?.DB) return true;
  if (!primaryRunLockEnabled(env)) return true;
  try {
    await ensurePrimaryRunLockSchema(env.DB);
    const leaseUntil = now + ttlMs(env);
    const row = await env.DB.prepare(CLAIM_SQL)
      .bind(SCOPE, holderId, now, leaseUntil, now)
      .first();
    return Boolean(row);
  } catch (error) {
    if (noSuchTable(error)) return true;
    console.error(JSON.stringify({
      event: 'primary_run_lock_claim_failed',
      error: String(error?.message || error).slice(0, 500),
    }));
    return true;
  }
}

// Read-only check other workers can use to back off heavy/bursty D1 writes
// (e.g. snapshot retention) while buddies is actively mid-collection, since
// D1/SQLite serializes writes database-wide -- a large write burst from
// another worker can add latency to buddies' own writes even on unrelated
// tables. Fails open (treats buddies as not active) on any error so a
// lock-table problem can never make another worker's task starve forever.
export async function isPrimaryRunLockActive(env, now = Date.now()) {
  if (!env?.DB) return false;
  try {
    const row = await env.DB.prepare(STATUS_SQL).bind(SCOPE).first();
    return Boolean(row) && Number(row.lease_until) > now;
  } catch (error) {
    if (noSuchTable(error)) return false;
    console.error(JSON.stringify({
      event: 'primary_run_lock_status_check_failed',
      error: String(error?.message || error).slice(0, 500),
    }));
    return false;
  }
}

export async function releasePrimaryRunLock(env, holderId, now = Date.now()) {
  if (!env?.DB) return false;
  try {
    const result = await env.DB.prepare(RELEASE_SQL).bind(now, SCOPE, holderId).run();
    return Number(result?.meta?.changes || 0) > 0;
  } catch (error) {
    if (noSuchTable(error)) return false;
    console.error(JSON.stringify({
      event: 'primary_run_lock_release_failed',
      error: String(error?.message || error).slice(0, 500),
    }));
    return false;
  }
}
