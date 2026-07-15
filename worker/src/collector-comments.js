import { normalizeComments } from './shared.js';
import { sanitizeFailureDetail } from './collector-failure.js';
import { ingest } from './collector-ingest.js';
import { shJson } from './collector-config.js';

function collectionAbortReason(config, fallback) {
  const signal = config?.collectionSignal;
  if (!signal?.aborted) return null;
  return signal.reason instanceof Error ? signal.reason : fallback;
}

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
    const ingestResult = await writeIngest(env, 'comments', {
      station_id: state.stationId,
      comments,
      raw_meta: { next: history?.chats?.next ?? history?.next ?? null },
    }, observedAt, { returnDetails: true });
    const commentDetails = ingestResult?.totalKnown === true
      ? {
        commentTotal: Number(ingestResult.total),
        commentTotalKnown: true,
      }
      : {};
    return {
      commentsSaved: comments.length,
      degraded: false,
      errorStage: null,
      ...commentDetails,
    };
  } catch (error) {
    const abortReason = collectionAbortReason(config, error);
    if (abortReason) throw abortReason;
    warn(JSON.stringify({
      event: 'optional_comment_collection_failed',
      stage,
      error: sanitizeFailureDetail(error?.message || error),
    }));
    return { commentsSaved: 0, degraded: true, errorStage: stage };
  }
}
