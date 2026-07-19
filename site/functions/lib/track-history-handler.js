import {
  handleTrackHistory as handleRestoredTrackHistory,
  loadTrackHistoryData as loadRestoredTrackHistoryData,
  TRACK_HISTORY_GRACE_MS,
  TRACK_HISTORY_SQL as RESTORED_TRACK_HISTORY_SQL,
} from './track-history-restored-handler.js';
import {
  appleMusicFreeTrackHistoryDatabase,
  withAppleMusicFreeTrackHistoryEnv,
  withoutAppleMusicTrackHistorySql,
} from './apple-music-track-history-sql.js';

export { TRACK_HISTORY_GRACE_MS };
export const TRACK_HISTORY_SQL = withoutAppleMusicTrackHistorySql(RESTORED_TRACK_HISTORY_SQL);

export function loadTrackHistoryData(db, ...args) {
  return loadRestoredTrackHistoryData(appleMusicFreeTrackHistoryDatabase(db), ...args);
}

export function handleTrackHistory(context) {
  return handleRestoredTrackHistory({
    ...context,
    env: withAppleMusicFreeTrackHistoryEnv(context?.env),
  });
}
