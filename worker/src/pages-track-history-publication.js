import {
  splitTrackHistoryPublicationRows,
  TRACK_HISTORY_MODEL_KEY,
  TRACK_HISTORY_RESPONSE_LIMIT,
  TRACK_HISTORY_RESPONSE_MAX_CHUNKS,
  trackHistoryResponsePrefix,
  trackHistoryResponseSuffix,
} from './pages-track-history-response.js';

const RESPONSE_HEADERS = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
});

const RESPONSE_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS sh_pages_response_manifest (
    model_key TEXT PRIMARY KEY,
    generation TEXT NOT NULL,
    status INTEGER NOT NULL,
    headers_json TEXT NOT NULL,
    chunk_count INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sh_pages_response_chunks (
    model_key TEXT NOT NULL,
    generation TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    payload_chunk TEXT NOT NULL,
    PRIMARY KEY(model_key,generation,chunk_index)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sh_pages_response_chunks_generation
    ON sh_pages_response_chunks(model_key,generation,chunk_index)`,
];

function integer(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = integer(value);
  return parsed != null && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

async function ensureResponseSchema(db) {
  await db.batch(RESPONSE_SCHEMA_SQL.map((sql) => db.prepare(sql)));
}

async function resetGeneration(db, publication) {
  await db.batch([
    db.prepare(`DELETE FROM sh_pages_response_chunks
      WHERE model_key=? AND generation=?`).bind(TRACK_HISTORY_MODEL_KEY, publication.generation),
    db.prepare(`INSERT INTO sh_pages_response_chunks(
        model_key,generation,chunk_index,payload_chunk
      ) VALUES(?,?,0,?) ON CONFLICT(model_key,generation,chunk_index) DO UPDATE SET
        payload_chunk=excluded.payload_chunk`)
      .bind(TRACK_HISTORY_MODEL_KEY, publication.generation, trackHistoryResponsePrefix(publication)),
  ]);
}

export async function initializeTrackHistoryPublication(db, publication, dependencies = {}) {
  const ensureSchema = dependencies.ensureSchema || ensureResponseSchema;
  const reset = dependencies.resetGeneration || resetGeneration;
  await ensureSchema(db);
  await reset(db, publication);
  return { ...publication };
}

function cursorClause(cursor) {
  if (!cursor) return { sql: '', binds: [] };
  const playedAt = integer(cursor.first_played_at) ?? -1;
  return {
    sql: `AND (
      play_date>? OR
      (play_date=? AND COALESCE(first_played_at,-1)>?) OR
      (play_date=? AND COALESCE(first_played_at,-1)=? AND row_key>?)
    )`,
    binds: [cursor.play_date, cursor.play_date, playedAt, cursor.play_date, playedAt, cursor.row_key],
  };
}

async function loadRows(db, publication, limit) {
  const cursor = cursorClause(publication.cursor);
  const result = await db.prepare(`SELECT
      row_key,play_date,first_played_at,row_json,json_valid(row_json) AS row_json_valid
    FROM sh_pages_track_history_read_model
    WHERE play_date>=? AND play_date<=?
    ${cursor.sql}
    ORDER BY play_date ASC,COALESCE(first_played_at,-1) ASC,row_key ASC
    LIMIT ?`)
    .bind(publication.from, publication.to, ...cursor.binds, limit)
    .all();
  return result.results || [];
}

async function writeChunks(db, publication, chunks) {
  if (!chunks.length) return;
  const statements = chunks.map((chunk, offset) => db.prepare(`INSERT INTO sh_pages_response_chunks(
      model_key,generation,chunk_index,payload_chunk
    ) VALUES(?,?,?,?) ON CONFLICT(model_key,generation,chunk_index) DO UPDATE SET
      payload_chunk=excluded.payload_chunk`)
    .bind(
      TRACK_HISTORY_MODEL_KEY,
      publication.generation,
      publication.next_chunk_index + offset,
      chunk,
    ));
  await db.batch(statements);
}

async function publishManifest(db, publication, now) {
  const suffixIndex = publication.next_chunk_index;
  const chunkCount = suffixIndex + 1;
  if (chunkCount > TRACK_HISTORY_RESPONSE_MAX_CHUNKS) {
    throw new Error(`track-history response exceeded ${TRACK_HISTORY_RESPONSE_MAX_CHUNKS} chunks`);
  }
  await db.batch([
    db.prepare(`INSERT INTO sh_pages_response_chunks(
        model_key,generation,chunk_index,payload_chunk
      ) VALUES(?,?,?,?) ON CONFLICT(model_key,generation,chunk_index) DO UPDATE SET
        payload_chunk=excluded.payload_chunk`)
      .bind(
        TRACK_HISTORY_MODEL_KEY,
        publication.generation,
        suffixIndex,
        trackHistoryResponseSuffix(publication),
      ),
    db.prepare(`INSERT INTO sh_pages_response_manifest(
        model_key,generation,status,headers_json,chunk_count,updated_at
      ) VALUES(?,?,?,?,?,?) ON CONFLICT(model_key) DO UPDATE SET
        generation=excluded.generation,status=excluded.status,headers_json=excluded.headers_json,
        chunk_count=excluded.chunk_count,updated_at=excluded.updated_at`)
      .bind(
        TRACK_HISTORY_MODEL_KEY,
        publication.generation,
        200,
        JSON.stringify(RESPONSE_HEADERS),
        chunkCount,
        integer(now) ?? Date.now(),
      ),
    db.prepare(`DELETE FROM sh_pages_response_chunks
      WHERE model_key=? AND generation<>?`)
      .bind(TRACK_HISTORY_MODEL_KEY, publication.generation),
  ]);
  return { chunks: chunkCount };
}

export async function advanceTrackHistoryPublication(db, value, now = Date.now(), dependencies = {}) {
  const publication = { ...value };
  if (publication.phase === 'published') {
    return { publication, action: 'already-published', published: true, rows: 0, chunks: 0 };
  }
  if (publication.phase === 'finalize') {
    const publish = dependencies.publishManifest || publishManifest;
    const result = await publish(db, publication, now);
    publication.phase = 'published';
    publication.updated_at = integer(now) ?? Date.now();
    return {
      publication,
      action: 'publish',
      published: true,
      rows: 0,
      chunks: Number(result?.chunks || publication.next_chunk_index + 1),
    };
  }

  const remaining = Math.max(
    0,
    positiveInteger(publication.limit, TRACK_HISTORY_RESPONSE_LIMIT)
      - Number(publication.rows_written || 0),
  );
  const pageRows = Math.min(remaining, positiveInteger(publication.page_rows, 100, 500));
  if (pageRows <= 0) {
    publication.phase = 'finalize';
    publication.truncated = true;
    publication.updated_at = integer(now) ?? Date.now();
    return { publication, action: 'rows-complete', published: false, rows: 0, chunks: 0 };
  }

  const load = dependencies.loadRows || loadRows;
  const rawRows = await load(db, publication, pageRows + 1);
  const hasMore = rawRows.length > pageRows;
  const rows = hasMore ? rawRows.slice(0, pageRows) : rawRows;
  const chunks = splitTrackHistoryPublicationRows(rows, Number(publication.rows_written || 0));
  if (Number(publication.next_chunk_index || 1) + chunks.length + 1 > TRACK_HISTORY_RESPONSE_MAX_CHUNKS) {
    throw new Error(`track-history response exceeded ${TRACK_HISTORY_RESPONSE_MAX_CHUNKS} chunks`);
  }
  const write = dependencies.writeChunks || writeChunks;
  await write(db, publication, chunks);

  if (rows.length) {
    const last = rows[rows.length - 1];
    publication.cursor = {
      play_date: String(last.play_date),
      first_played_at: integer(last.first_played_at),
      row_key: String(last.row_key),
    };
  }
  publication.rows_written = Number(publication.rows_written || 0) + rows.length;
  publication.next_chunk_index = Number(publication.next_chunk_index || 1) + chunks.length;
  publication.truncated = publication.rows_written >= publication.limit && hasMore;
  publication.updated_at = integer(now) ?? Date.now();
  if (!hasMore || publication.rows_written >= publication.limit) publication.phase = 'finalize';

  return {
    publication,
    action: publication.phase === 'finalize' ? 'rows-complete' : 'rows',
    published: false,
    rows: rows.length,
    chunks: chunks.length,
  };
}
