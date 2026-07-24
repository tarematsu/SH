const LIVE_SOURCE_CODE = 1;

export const SPARSE_LIVE_VALUE_FIELDS = Object.freeze([
  'is_broadcasting',
  'listener_count',
  'online_member_count',
  'guest_count',
  'reported_total_listens',
  'reported_current_stream_count',
  'comment_count',
  'comment_total',
]);

const latestValueSelect = (column) => `(SELECT previous.${column}
  FROM sh_minute_facts AS previous
  WHERE previous.source_code=${LIVE_SOURCE_CODE}
    AND previous.channel_id=?
    AND previous.${column} IS NOT NULL
  ORDER BY previous.minute_at DESC,previous.id DESC
  LIMIT 1) AS ${column}`;

export const LOAD_LATEST_LIVE_VALUES_SQL = `SELECT
  (SELECT previous.minute_at
    FROM sh_minute_facts AS previous
    WHERE previous.source_code=${LIVE_SOURCE_CODE} AND previous.channel_id=?
    ORDER BY previous.minute_at DESC,previous.id DESC
    LIMIT 1) AS minute_at,
  ${SPARSE_LIVE_VALUE_FIELDS.map(latestValueSelect).join(',\n  ')}`;

let stateCaches = new WeakMap();

function cacheFor(db) {
  let cache = stateCaches.get(db);
  if (!cache) {
    cache = new Map();
    stateCaches.set(db, cache);
  }
  return cache;
}

function emptyState() {
  return {
    minuteAt: null,
    values: Object.fromEntries(SPARSE_LIVE_VALUE_FIELDS.map((field) => [field, null])),
  };
}

function stateFromRow(row) {
  const state = emptyState();
  const minuteAt = Number(row?.minute_at);
  state.minuteAt = Number.isFinite(minuteAt) ? Math.trunc(minuteAt) : null;
  for (const field of SPARSE_LIVE_VALUE_FIELDS) {
    if (row?.[field] !== null && row?.[field] !== undefined) state.values[field] = row[field];
  }
  return state;
}

async function loadState(db, channelId) {
  try {
    const params = new Array(SPARSE_LIVE_VALUE_FIELDS.length + 1).fill(channelId);
    const row = await db.prepare(LOAD_LATEST_LIVE_VALUES_SQL).bind(...params).first();
    return stateFromRow(row);
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'minute_fact_sparse_state_load_failed',
      channel_id: channelId,
      error: String(error?.message || error),
    }));
    return emptyState();
  }
}

async function cachedState(db, channelId) {
  const cache = cacheFor(db);
  let state = cache.get(channelId);
  if (!state) {
    const pending = loadState(db, channelId);
    cache.set(channelId, pending);
    state = await pending;
    cache.set(channelId, state);
    return state;
  }
  if (state instanceof Promise) {
    state = await state;
    cache.set(channelId, state);
  }
  return state;
}

function sameValue(left, right) {
  return left === right || (Number.isNaN(left) && Number.isNaN(right));
}

export function sparseLiveValues(fact, previousValues = {}) {
  const sparse = { ...fact };
  const omitted = [];
  for (const field of SPARSE_LIVE_VALUE_FIELDS) {
    const value = fact[field];
    if (value === null || value === undefined) continue;
    if (!sameValue(value, previousValues[field])) continue;
    sparse[field] = null;
    omitted.push(field);
  }
  return { fact: sparse, omitted };
}

export async function prepareSparseLiveMinuteFact(db, fact) {
  const channelId = Number(fact?.channel_id);
  const minuteAt = Number(fact?.minute_at);
  if (!db || Number(fact?.source_code) !== LIVE_SOURCE_CODE
      || !Number.isFinite(channelId) || !Number.isFinite(minuteAt)) {
    return { fact, omitted: [], commit() {} };
  }

  const cache = cacheFor(db);
  const previous = await cachedState(db, Math.trunc(channelId));

  // Replays and out-of-order repairs must retain their complete values. If a
  // same-minute retry were sparsified against the first attempt, it could
  // overwrite the changed value with NULL and incorrectly carry an older value.
  if (previous.minuteAt != null && minuteAt <= previous.minuteAt) {
    return { fact, omitted: [], commit() {} };
  }

  const prepared = sparseLiveValues(fact, previous.values);
  return {
    ...prepared,
    commit() {
      const values = { ...previous.values };
      for (const field of SPARSE_LIVE_VALUE_FIELDS) {
        const value = fact[field];
        if (value !== null && value !== undefined) values[field] = value;
      }
      cache.set(Math.trunc(channelId), { minuteAt: Math.trunc(minuteAt), values });
    },
  };
}

export function resetSparseLiveValueStateForTests(db = null) {
  if (db) stateCaches.delete(db);
  else stateCaches = new WeakMap();
}
