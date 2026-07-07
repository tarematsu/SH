import { normalizeComments } from './shared.js';
import { sanitizeFailureDetail } from './collector-failure.js';
import { ingest } from './collector-ingest.js';
import { shJson } from './collector-config.js';

export async function collectOptionalComments(env, state, config, observedAt, dependencies = {}) {
  if (!state?.stationId || Number(config?.chatLimit || 0) <= 0) {
    return { commentsSaved: 0, degraded: false, errorStage: null };
  }

  const requestJson = dependencies.requestJson || shJson;
  const writeIngest = dependencies.writeIngest || ingest;
  const warn = dependencies.warn || console.warn;
  let stage = 'sh_chat_history';

  try {
    const history = await requestJson(
      state,
      config,
      `/station/${encodeURIComponent(state.stationId)}/chatHistory?limit=${config.chatLimit}`,
    );
    stage = 'sh_chat_payload';
    const comments = normalizeComments(history, state.stationId);
    stage = 'd1_write_comments';
    await writeIngest(env, 'comments', {
      station_id: state.stationId,
      comments,
      raw_meta: { next: history?.chats?.next ?? history?.next ?? null },
    }, observedAt);
    return { commentsSaved: comments.length, degraded: false, errorStage: null };
  } catch (error) {
    warn(JSON.stringify({
      event: 'comment_collection_failed',
      stage,
      error: sanitizeFailureDetail(error?.message || error),
    }));
    return { commentsSaved: 0, degraded: true, errorStage: stage };
  }
}
