import {
  dueFastMaterializedVariants,
  ensurePagesReadModelSchema,
  materializedVariantDue,
  materializePagesVariants,
  pagesReadModelEnvironment,
  pagesResponseSummary,
  trackHistoryMaterializedVariant,
} from './pages-read-model-publication.js';
import { refreshTrackHistoryReadModel } from './pages-track-history-read-model.js';

export {
  mergeTrackHistoryExcludedDates,
  trackHistoryRefreshRanges,
} from './pages-track-history-support.js';
export { dueFastMaterializedVariants, materializedVariantDue };

export async function refreshFastPagesReadModels(env, now = Date.now(), dependencies = {}) {
  const targetDb = env?.MINUTE_DB;
  if (!env?.BUDDIES_DB || !targetDb || !env?.OTHER_DB) {
    return { skipped: true, reason: 'db-binding-missing' };
  }
  await ensurePagesReadModelSchema(targetDb);
  const dueVariants = dueFastMaterializedVariants(now);
  const responses = await materializePagesVariants(
    dueVariants,
    targetDb,
    pagesReadModelEnvironment(env),
    now,
    dependencies,
  );
  return {
    skipped: false,
    generated_at: now,
    ...pagesResponseSummary(responses),
  };
}

export async function refreshTrackHistoryPagesReadModel(env, now = Date.now(), dependencies = {}) {
  const sourceDb = env?.BUDDIES_DB;
  const targetDb = env?.MINUTE_DB;
  if (!sourceDb || !targetDb) return { skipped: true, reason: 'db-binding-missing' };
  await ensurePagesReadModelSchema(targetDb);

  const refreshTracks = dependencies.refreshTracks
    || ((activeSource, activeTarget, timestamp) => refreshTrackHistoryReadModel(
      activeSource,
      activeTarget,
      timestamp,
      dependencies,
    ));
  const tracks = await refreshTracks(sourceDb, targetDb, now);
  const responses = await materializePagesVariants(
    [trackHistoryMaterializedVariant()],
    targetDb,
    pagesReadModelEnvironment(env),
    now,
    dependencies,
  );
  return {
    skipped: false,
    generated_at: now,
    tracks,
    ...pagesResponseSummary(responses, 1),
  };
}

export async function refreshPagesReadModels(env, now = Date.now(), dependencies = {}) {
  const sourceDb = env?.BUDDIES_DB;
  const targetDb = env?.MINUTE_DB;
  if (!sourceDb || !targetDb) return { skipped: true, reason: 'db-binding-missing' };
  await ensurePagesReadModelSchema(targetDb);

  const refreshTracks = dependencies.refreshTracks
    || ((activeSource, activeTarget, timestamp) => refreshTrackHistoryReadModel(
      activeSource,
      activeTarget,
      timestamp,
      dependencies,
    ));
  const tracks = await refreshTracks(sourceDb, targetDb, now);
  const responses = await materializePagesVariants(
    [trackHistoryMaterializedVariant()],
    targetDb,
    pagesReadModelEnvironment(env),
    now,
    dependencies,
  );
  return {
    skipped: false,
    generated_at: now,
    tracks,
    ...pagesResponseSummary(responses, 1),
  };
}
