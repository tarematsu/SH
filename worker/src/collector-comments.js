import { finiteNumber } from './shared.js';
import { sanitizeFailureDetail } from './collector-failure.js';
import { ingest } from './collector-ingest.js';
import { shJson } from './collector-config.js';

export const NO_COMMENTS_RESULT = Object.freeze({
  commentsSaved: 0,
  degraded: false,
  errorStage: null,
});
const NO_COMMENTS_PROMISE = Promise.resolve(NO_COMMENTS_RESULT);

export function optionalCommentsEnabled(state, config) {
  return Boolean(state?.stationId) && Number(config?.chatLimit || 0) > 0;
}

function commentItems(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.data?.items)) return payload.data.items;
  if (Array.isArray(payload?.chats?.items)) return payload.chats.items;
  return Array.isArray(payload?.chats) ? payload.chats : [];
}

export function normalizeCommentCountInputs(payload, stationId) {
  const comments = [];
  const numericIds = new Set();
  const rawIds = new Set();
  const fallbackStationId = finiteNumber(stationId);

  for (const chat of commentItems(payload)) {
    const rawId = chat?.comment_id ?? chat?.id;
    const commentId = finiteNumber(rawId);
    if (commentId != null) {
      if (numericIds.has(commentId)) continue;
      numericIds.add(commentId);
    } else {
      const identity = String(rawId ?? '').trim();
      if (!identity || rawIds.has(identity)) continue;
      rawIds.add(identity);
    }
    comments.push({
      comment_id: commentId,
      id: rawId,
      station_id: finiteNumber(chat?.station_id ?? fallbackStationId),
      chat_time: finiteNumber(chat?.chat_time),
      chat_time_ms: finiteNumber(chat?.chat_time_ms),
    });
  }
  return comments;
}

function collectionAbortReason(config, fallback) {
  const signal = config?.collectionSignal;
  if (!signal?.aborted) return null;
  return signal.reason instanceof Error ? signal.reason : fallback;
}

async function collectComments(env, state, config, observedAt, dependencies) {
  const requestJson = dependencies?.requestJson || shJson;
  const writeIngest = dependencies?.writeIngest || ingest;
  const warn = dependencies?.warn || console.warn;
  let stage = 'sh_chat_history';

  try {
    const history = await requestJson(
      state,
      config,
      `/station/${encodeURIComponent(state.stationId)}/chatHistory?limit=${config.chatLimit}`,
    );
    stage = 'sh_chat_payload';
    const comments = normalizeCommentCountInputs(history, state.stationId);
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

export function collectOptionalComments(env, state, config, observedAt, dependencies = null) {
  if (!optionalCommentsEnabled(state, config)) {
    return NO_COMMENTS_PROMISE;
  }
  return collectComments(env, state, config, observedAt, dependencies);
}
