const CACHE_MS = 5 * 60 * 1000;
const snapshotCountCache = { value: null, expiresAt: 0, pending: null };

export async function cachedSnapshotCount(db, now = Date.now()) {
  if (snapshotCountCache.value != null && snapshotCountCache.expiresAt > now) {
    return snapshotCountCache.value;
  }
  if (!snapshotCountCache.pending) {
    snapshotCountCache.pending = db.prepare('SELECT COUNT(*) AS count FROM snapshots').first()
      .then((row) => {
        const value = Number(row?.count || 0);
        snapshotCountCache.value = value;
        snapshotCountCache.expiresAt = Date.now() + CACHE_MS;
        return value;
      })
      .finally(() => { snapshotCountCache.pending = null; });
  }
  return snapshotCountCache.pending;
}

export function resetSnapshotCountCache() {
  snapshotCountCache.value = null;
  snapshotCountCache.expiresAt = 0;
  snapshotCountCache.pending = null;
}

export async function onRequestGet(context) {
  const snapshotCount = await cachedSnapshotCount(context.env.DB);
  return Response.json({
    ok: true,
    snapshotCount,
    time: new Date().toISOString(),
  }, {
    headers: { 'cache-control': 'public, max-age=60, s-maxage=300, stale-while-revalidate=600' },
  });
}
