const OFFICIAL_NEWS_DUE_SQL = `SELECT 1 AS due FROM sh_official_news_announcements
  WHERE scheduled_at IS NOT NULL AND (
    (status='scheduled' AND scheduled_at>=? AND scheduled_at<=?) OR status='active'
  ) LIMIT 1`;

const DUE_CACHE_SLOT_MS = 5 * 60_000;
const officialNewsDueCaches = new WeakMap();
let officialNewsProbeModulePromise;
let officialNewsReconcileModulePromise;
let officialNewsUtilsModulePromise;

function loadOfficialNewsProbeModule() {
  officialNewsProbeModulePromise ||= import('./official-news-probe.js');
  return officialNewsProbeModulePromise;
}

function loadOfficialNewsReconcileModule() {
  officialNewsReconcileModulePromise ||= import('./official-news-reconcile.js');
  return officialNewsReconcileModulePromise;
}

function loadOfficialNewsUtilsModule() {
  officialNewsUtilsModulePromise ||= import('./official-news-utils.js');
  return officialNewsUtilsModulePromise;
}

function positiveMs(value, fallback) {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : fallback;
  }
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

export function scheduledTimestamp(controller, fallback) {
  const raw = controller?.scheduledTime;
  if (typeof raw === 'number') {
    if (Number.isFinite(raw) && raw >= 0) return raw;
  } else {
    const value = Number(raw);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return fallback ?? Date.now();
}

export async function officialNewsProbeDue(env, now = Date.now()) {
  const db = env?.OTHER_DB;
  if (!db?.prepare) return false;
  const slot = Math.floor(now / DUE_CACHE_SLOT_MS);
  const cached = officialNewsDueCaches.get(db);
  if (cached?.slot === slot) return cached.due;
  const earlyMs = positiveMs(env.OFFICIAL_NEWS_EARLY_WINDOW_MS, 10 * 60_000);
  const lateMs = positiveMs(env.OFFICIAL_NEWS_LATE_WINDOW_MS, 90 * 60_000);
  try {
    const row = await db.prepare(OFFICIAL_NEWS_DUE_SQL)
      .bind(now - lateMs, now + earlyMs)
      .first();
    const due = Boolean(row?.due);
    officialNewsDueCaches.set(db, { slot, due });
    return due;
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'official_news_due_check_failed',
      error: String(error?.message || error).slice(0, 500),
    }));
    return false;
  }
}

export async function runOfficialNewsWithReconcile(env, now, probe = null, reconcile = null) {
  const activeProbe = probe || (await loadOfficialNewsProbeModule()).runOfficialNewsMonitor;
  const activeReconcile = reconcile || (await loadOfficialNewsReconcileModule()).reconcileOfficialAnnouncements;
  const { officialNewsConfig } = await loadOfficialNewsUtilsModule();
  const probeEnv = probe ? Object.create(env || null) : env;
  const result = await activeProbe(probeEnv, officialNewsConfig(env), now);
  await activeReconcile(env, now);
  return result;
}
