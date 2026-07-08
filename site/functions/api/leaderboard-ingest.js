import { claimWrite, payloadHash, sourceIdentity } from '../lib/ingest-claim.js';
import {
  ingestAccessError,
  json,
  observedAtFrom,
  rawJson,
  readJsonBody,
  text,
  num,
} from '../lib/api-utils.js';
import { prepared, runPreparedD1Batches } from '../lib/d1-batch.js';

export const D1_LEADERBOARD_BATCH_VARIABLE_LIMIT = 90;
const DEFAULT_RANKING_TYPE = '週間チャンネル順位';
const DEFAULT_LEADERBOARD_SOURCE = 'stationhead_official';

async function runPreparedBatches(db, statements) {
  await runPreparedD1Batches(db, statements, {
    variableLimit: D1_LEADERBOARD_BATCH_VARIABLE_LIMIT,
  });
}

function validDateKey(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function normalizeLeaderboardAccounts(accounts) {
  return accounts
    .map((account, index) => ({
      rank: num(account?.rank) ?? index + 1,
      handle: text(account?.handle)?.trim(),
      account_id: num(account?.account_id),
      leaderboard_movement: account?.leaderboard_movement ?? null,
      is_broadcasting: Boolean(account?.is_broadcasting),
      station_status: text(account?.station_status),
      thumbnail_url: text(account?.thumbnail_url),
      badges: Array.isArray(account?.badges) ? account.badges : [],
      raw: account?.raw ?? account,
    }))
    .filter((account) => account.handle && account.rank > 0)
    .sort((a, b) => a.rank - b.rank || a.handle.localeCompare(b.handle));
}

function leaderboardClaimPayload(accounts) {
  return accounts.map((account) => ({
    rank: account.rank,
    handle: account.handle.toLowerCase(),
    account_id: account.account_id,
    leaderboard_movement: account.leaderboard_movement,
  }));
}

function rankingStatement(db, context, account) {
  return prepared(db.prepare(`
    INSERT INTO sh_channel_rankings (
      ranking_date, observed_at, ranking_type, rank,
      channel_name, channel_alias,
      listener_count, member_count, total_listens,
      source_sheet, source_row,
      quality_score, quality_flags, raw_json, imported_at
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, 1, ?, ?, ?)
    ON CONFLICT(ranking_date, ranking_type, channel_name) DO UPDATE SET
      observed_at = excluded.observed_at,
      rank = excluded.rank,
      channel_alias = excluded.channel_alias,
      source_sheet = excluded.source_sheet,
      source_row = excluded.source_row,
      quality_score = excluded.quality_score,
      quality_flags = excluded.quality_flags,
      raw_json = excluded.raw_json,
      imported_at = excluded.imported_at
  `).bind(
    context.rankingDate,
    context.observedAt,
    context.rankingType,
    account.rank,
    account.handle,
    account.handle,
    context.source,
    account.rank,
    rawJson({
      source_hash: context.hash,
      leaderboard_movement: account.leaderboard_movement,
      official: true,
      collector_id: context.collector.collectorId,
      collector_kind: context.collector.collectorKind,
      source_priority: context.collector.sourcePriority,
    }),
    rawJson({
      ...account.raw,
      captured_rank: account.rank,
      captured_at: context.observedAt,
      ranking_date: context.rankingDate,
    }),
    context.observedAt,
  ), 11);
}

function leaderboardFetchStatement(db, context, accounts) {
  return prepared(db.prepare(`
    INSERT INTO sh_leaderboard_fetches (
      ranking_date, fetched_at, source, source_hash, row_count, status, raw_json
    ) VALUES (?, ?, ?, ?, ?, 'saved', ?)
    ON CONFLICT(ranking_date, source) DO UPDATE SET
      fetched_at = excluded.fetched_at,
      source_hash = excluded.source_hash,
      row_count = excluded.row_count,
      status = excluded.status,
      raw_json = excluded.raw_json
  `).bind(
    context.rankingDate,
    context.observedAt,
    context.source,
    context.hash,
    accounts.length,
    rawJson({
      ranking_type: context.rankingType,
      handles: accounts.map((account) => account.handle),
      collector_id: context.collector.collectorId,
      collector_kind: context.collector.collectorKind,
      source_priority: context.collector.sourcePriority,
    }),
  ), 6);
}

function staleRankingCleanupStatement(db, context) {
  return prepared(db.prepare(`
    DELETE FROM sh_channel_rankings
    WHERE ranking_date = ? AND ranking_type = ?
      AND CASE
        WHEN quality_flags IS NULL OR NOT json_valid(quality_flags) THEN ''
        ELSE COALESCE(json_extract(quality_flags, '$.source_hash'), '')
      END <> ?
  `).bind(context.rankingDate, context.rankingType, context.hash), 3);
}

function leaderboardWriteStatements(db, context, accounts) {
  return [
    ...accounts.map((account) => rankingStatement(db, context, account)),
    leaderboardFetchStatement(db, context, accounts),
    staleRankingCleanupStatement(db, context),
  ];
}

export async function onRequestPost({ request, env }) {
  const accessError = ingestAccessError(request, env);
  if (accessError) return accessError;

  const parsed = await readJsonBody(request);
  if (!parsed.ok) {
    return json({ ok: false, error: 'invalid JSON' }, 400);
  }
  const body = parsed.body;

  const observedAt = observedAtFrom(body);
  const rankingDate = text(body?.ranking_date);
  const rankingType = text(body?.ranking_type) || DEFAULT_RANKING_TYPE;
  const source = text(body?.source) || DEFAULT_LEADERBOARD_SOURCE;
  const sourceHash = text(body?.source_hash);
  const accounts = Array.isArray(body?.accounts) ? body.accounts : [];
  const collector = sourceIdentity(body, { collectorId: source });

  if (!validDateKey(rankingDate)) {
    return json({ ok: false, error: 'invalid ranking_date' }, 400);
  }
  if (!accounts.length) {
    return json({ ok: false, error: 'accounts are empty' }, 400);
  }

  const normalized = normalizeLeaderboardAccounts(accounts);
  if (!normalized.length) {
    return json({ ok: false, error: 'no valid accounts' }, 400);
  }

  const claimPayload = leaderboardClaimPayload(normalized);
  const hash = sourceHash || await payloadHash(claimPayload);
  const claim = await claimWrite(env.DB, {
    dedupeKey: `leaderboard:${rankingDate}:${rankingType}`,
    dataType: 'weekly_leaderboard',
    ...collector,
    observedAt,
    hash,
    payload: claimPayload,
    metadata: { ranking_date: rankingDate, ranking_type: rankingType, row_count: normalized.length },
  });

  if (!claim.accepted && !claim.duplicate) {
    return json({
      ok: true,
      ranking_date: rankingDate,
      rows: normalized.length,
      source_hash: hash,
      accepted: false,
      duplicate: false,
      claim_reason: claim.reason,
    });
  }

  const context = { observedAt, rankingDate, rankingType, source, hash, collector };
  const statements = leaderboardWriteStatements(env.DB, context, normalized);

  try {
    await runPreparedBatches(env.DB, statements);
    return json({
      ok: true,
      ranking_date: rankingDate,
      rows: normalized.length,
      source_hash: hash,
      accepted: claim.accepted,
      duplicate: claim.duplicate || false,
      claim_reason: claim.reason || null,
      saved: true,
    });
  } catch (error) {
    console.error(error);
    return json({ ok: false, error: error?.message || 'database error' }, 500);
  }
}

export async function onRequestGet() {
  return json({
    ok: true,
    endpoint: 'official weekly leaderboard ingest',
  });
}
