import { handleTrackHistory } from '../lib/track-history-restored-handler.js';

export function onRequestGet(context) {
  return handleTrackHistory({
    ...context,
    env: {
      ...context.env,
      // The restored query reads sh_queue_items/sh_queue_snapshots/sh_channel_snapshots,
      // which live in the primary buddies database rather than MINUTE_DB.
      MINUTE_DB: null,
    },
  });
}
