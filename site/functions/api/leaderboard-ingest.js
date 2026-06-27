import { claimWrite, payloadHash, sourceIdentity } from '../lib/ingest-claim.js';
import { json, authorized, num, text, rawJson } from '../lib/api-utils.js';

function validDateKey(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

export async function onRequestPost({ request, env }) {
  if (!authorized(request, env)) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }
  if (!env.DB) {
    return json({ ok: false, error: 'DB binding missing' }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'invalid JSON' }, 400);
  }

  const observedAt = num(body?.observed_at) ?? Date.now();
  const rankingDate = text(body?.ranking_date);
  const rankingType = text(body?.ranking_type) || '週間チャンネル順位';
  const source = text(body?.source) || 'stationhead_official';
  const sourceHash = text(body?.source_hash);
  const accounts = Array.isArray(body?.accounts) ? body.accounts : [];
  const collector = sourceIdentity(body, { collectorId: source });

  if (!validDateKey(rankingDate)) {
    return json({ ok: false, error: 'invalid ranking_date' }, 400);
  }
  if (!accounts.length) {
    return json({ ok: false, error: 'accounts are empty' }, 400);
  }

  const normalized = accounts
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

  if (!normalized.length) {
    return json({ ok: false, error: 'no valid accounts' }, 400);
  }

  const claimPayload = normalized.map((account) => ({
    rank: account.rank,
    handle: account.handle.toLowerCase(),
    account_id: account.account_id,
    leaderboard_movement: account.leaderboard_movement,
  }));
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

  if (!claim.accepted) {
    return json({
      ok: true,
      ranking_date: rankingDate,
      rows: normalized.length,
      source_hash: hash,
      accepted: false,
      duplicate: claim.duplicate,
      claim_reason: claim.reason,
    });
  }

  const statements = [
    env.DB.prepare(`
      DELETE FROM sh_channel_rankings
      WHERE ranking_date = ? AND ranking_type = ?
    `).bind(rankingDate, rankingType),
  ];

  for (const account of normalized) {
    statements.push(
      env.DB.prepare(`
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
        rankingDate,
        observedAt,
        rankingType,
        account.rank,
        account.handle,
        account.handle,
        source,
        account.rank,
        rawJson({
          source_hash: hash,
          leaderboard_movement: account.leaderboard_movement,
          official: true,
          collector_id: collector.collectorId,
          collector_kind: collector.collectorKind,
          source_priority: collector.sourcePriority,
        }),
        rawJson({
          ...account.raw,
          captured_rank: account.rank,
          captured_at: observedAt,
          ranking_date: rankingDate,
        }),
        observedAt,
      ),
    );
  }

  statements.push(
    env.DB.prepare(`
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
      rankingDate,
      observedAt,
      source,
      hash,
      normalized.length,
      rawJson({
        ranking_type: rankingType,
        handles: normalized.map((account) => account.handle),
        collector_id: collector.collectorId,
        collector_kind: collector.collectorKind,
        source_priority: collector.sourcePriority,
      }),
    ),
  );

  try {
    await env.DB.batch(statements);
    return json({
      ok: true,
      ranking_date: rankingDate,
      rows: normalized.length,
      source_hash: hash,
      accepted: true,
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
