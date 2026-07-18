export const TRACK_HISTORY_MODEL_KEY = 'track-history';
export const TRACK_HISTORY_RESPONSE_CHUNK_SIZE = 192_000;
export const TRACK_HISTORY_RESPONSE_MAX_CHUNKS = 80;
export const TRACK_HISTORY_RESPONSE_LIMIT = 10_000;

const DEFAULT_PAGE_ROWS = 100;
const MAX_PAGE_ROWS = 500;

function integer(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = integer(value);
  return parsed != null && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function dayText(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

export function createTrackHistoryPublication(stage, status, now = Date.now(), env = {}) {
  const generatedAt = integer(status?.generated_at) ?? integer(now) ?? Date.now();
  return {
    model_key: TRACK_HISTORY_MODEL_KEY,
    generation: `${integer(stage?.generation) ?? generatedAt}:track-history:${generatedAt}`,
    phase: 'rows',
    from: '2024-05-01',
    to: dayText(generatedAt),
    limit: TRACK_HISTORY_RESPONSE_LIMIT,
    page_rows: positiveInteger(env?.PAGES_TRACK_HISTORY_ROWS_PER_STEP, DEFAULT_PAGE_ROWS, MAX_PAGE_ROWS),
    rows_written: 0,
    next_chunk_index: 1,
    cursor: null,
    truncated: false,
    source_row_count: Math.max(0, Number(status?.source_row_count || 0)),
    excluded_play_count_dates: Array.isArray(status?.excluded_play_count_dates)
      ? status.excluded_play_count_dates.map(String)
      : [],
    generated_at: generatedAt,
    updated_at: generatedAt,
  };
}

export function trackHistoryResponsePrefix(publication) {
  const header = {
    ok: true,
    mode: 'tracks',
    from: publication.from,
    to: publication.to,
    timezone: 'UTC',
  };
  return `${JSON.stringify(header).slice(0, -1)},"rows":[`;
}

export function trackHistoryResponseSuffix(publication) {
  const excludedDates = Array.isArray(publication.excluded_play_count_dates)
    ? publication.excluded_play_count_dates
    : [];
  const tail = {
    truncated: publication.truncated === true,
    likes_included: false,
    source_row_count: Math.max(0, Number(publication.source_row_count || 0)),
    excluded_play_count_dates: excludedDates,
    excluded_play_count_date_count: excludedDates.length,
    generated_at: integer(publication.generated_at),
    historical_recovery: 'worker_materialized_read_model',
    method: 'precomputed_track_history_read_model',
  };
  return `],${JSON.stringify(tail).slice(1)}`;
}

function validatedTrackHistoryRowJson(row) {
  const raw = String(row?.row_json || 'null');
  if (row?.row_json_valid == null) {
    JSON.parse(raw);
  } else if (Number(row.row_json_valid) !== 1) {
    throw new Error('track-history row contained invalid JSON');
  }
  return raw;
}

export function splitTrackHistoryPublicationRows(
  rows,
  rowsWritten = 0,
  maximum = TRACK_HISTORY_RESPONSE_CHUNK_SIZE,
) {
  const chunks = [];
  let chunk = '';
  let offset = 0;
  for (const row of rows || []) {
    const raw = validatedTrackHistoryRowJson(row);
    const piece = `${rowsWritten + offset > 0 ? ',' : ''}${raw}`;
    if (piece.length > maximum) throw new Error('track-history row exceeded response chunk size');
    if (chunk && chunk.length + piece.length > maximum) {
      chunks.push(chunk);
      chunk = '';
    }
    chunk += piece;
    offset += 1;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

export function assembledTrackHistoryPublicationForTest(publication, rowChunks = []) {
  return `${trackHistoryResponsePrefix(publication)}${rowChunks.join('')}${trackHistoryResponseSuffix(publication)}`;
}
