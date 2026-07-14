const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60_000;
const MIN_RETENTION_MS = 24 * 60 * 60_000;
const DEFAULT_INTERVAL_MS = 60 * 60_000;
const MIN_INTERVAL_MS = 15 * 60_000;
const DEFAULT_BATCH_SIZE = 1000;
const MAX_BATCH_SIZE = 5000;
// Kept small on purpose: this worker shares a D1 database with sh-monitor-buddies,
// which writes into these same two tables every minute. A shorter worst-case
// burst (5 batches instead of a larger number) means less time this task can
// hold up buddies' own writes if it does run while buddies is mid-collection;
// a large initial backlog just drains over more hourly runs instead of one.
const DEFAULT_MAX_BATCHES = 5;
const MAX_MAX_BATCHES = 100;
const STATE_ID = 'snapshot-retention-v1';
const TABLES = ['sh_channel_snapshots', 'sh_queue_snapshots'];

function retentionMs(env = {}) {
  const configured = Number(env.SNAPSHOT_RETENTION_MS ?? DEFAULT_RETENTION_MS);
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_RETENTION_MS;
  return Math.max(MIN_RETENTION_MS, Math.trunc(configured));
}

function intervalMs(env = {}) {
  const configured = Number(env.SNAPSHOT_RETENTION_INTERVAL_MS ?? DEFAULT_INTERVAL_MS);
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_INTERVAL_MS;
  return Math.max(MIN_INTERVAL_MS, Math.trunc(configured));
}

function batchSize(env = {}) {
  const configured = Number(env.SNAPSHOT_RETENTION_BATCH_SIZE ?? DEFAULT_BATCH_SIZE);
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_BATCH_SIZE;
  return Math.min(MAX_BATCH_SIZE, Math.max(100, Math.trunc(configured)));
}

function maxBatches(env = {}) {
  const configured = Number(env.SNAPSHOT_RETENTION_MAX_BATCHES ?? DEFAULT_MAX_BATCHES);
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_MAX_BATCHES;
  return Math.min(MAX_MAX_BATCHES, Math.max(1, Math.trunc(configured)));
}

export function snapshotRetentionEnabled(env = {}) {
  const configured = env.SNAPSHOT_RETENTION_ENABLED;
  if (configured == null || configured === '') return true;
  return !['0', 'false', 'no', 'off'].includes(String(configured).trim().toLowerCase());
}

export function shouldRunSnapshotRetention(lastCleanupAt, now = Date.now(), env = {}) {
  return now - Number(lastCleanupAt || 0) >= intervalMs(env);
}

// DELETE FROM <table> WHERE id IN (SELECT id ... LIMIT ?) keeps each statement's
// row scan bounded (D1/SQLite has no LIMIT clause on a bare DELETE), and the
// per-table loop below re-runs it until a batch comes back short so a large
// backlog drains over a few hourly runs instead of timing out in one shot.
async function pruneTable(db, table, cutoff, size, batches) {
  let totalDeleted = 0;
  for (let batch = 0; batch < batches; batch += 1) {
    const result = await db.prepare(`DELETE FROM ${table} WHERE id IN (
        SELECT id FROM ${table} WHERE observed_at<? ORDER BY observed_at ASC LIMIT ?
      )`).bind(cutoff, size).run();
    const changes = Number(result?.meta?.changes || 0);
    totalDeleted += changes;
    if (changes < size) break;
  }
  return totalDeleted;
}

export async function pruneOldSnapshots(env, now = Date.now()) {
  if (!snapshotRetentionEnabled(env)) return { skipped: true, reason: 'disabled' };
  return { skipped: true, reason: 'archive-retention-disabled' };
}

export async function pruneOldSnapshotsSafely(env, now = Date.now()) {
  try {
    return await pruneOldSnapshots(env, now);
  } catch (error) {
    console.error(JSON.stringify({
      event: 'snapshot_retention_failed',
      error: String(error?.message || error).slice(0, 1000),
    }));
    return { skipped: true, reason: 'retention-error', error: error?.message || String(error) };
  }
}
