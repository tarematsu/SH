import {
  bool,
  integer,
  normalizedHandle,
  normalizedIsrc,
  normalizedLegacyTrack,
  text,
  timestampMs,
  uniqueAliases,
} from './minute-facts-normalize.js';

const SESSION_GAP_MS = 6 * 60 * 60_000;

async function findAlias(db, table, idColumn, aliases) {
  for (const alias of aliases) {
    const row = await db.prepare(`SELECT ${idColumn} AS id FROM ${table}
      WHERE alias_type=? AND alias_value=?`).bind(alias.type, alias.value).first();
    if (row?.id != null) return Number(row.id);
  }
  return null;
}

async function upsertAliases(db, table, idColumn, entityId, aliases, observedAt) {
  for (const alias of aliases) {
    await db.prepare(`INSERT INTO ${table}(alias_type,alias_value,${idColumn},first_seen_at,last_seen_at)
      VALUES(?,?,?,?,?) ON CONFLICT(alias_type,alias_value) DO UPDATE SET
      last_seen_at=MAX(${table}.last_seen_at,excluded.last_seen_at)`)
      .bind(alias.type, alias.value, entityId, observedAt, observedAt).run();
  }
}

function orderedAliasLookup(aliases) {
  const pairs = aliases.flatMap((alias) => [alias.type, alias.value]);
  return {
    predicate: aliases.map(() => '(alias_type=? AND alias_value=?)').join(' OR '),
    priority: `CASE ${aliases.map((_, index) => (
      `WHEN alias_type=? AND alias_value=? THEN ${index}`
    )).join(' ')} ELSE ${aliases.length} END`,
    binds: pairs.concat(pairs),
  };
}

async function updateExistingHost(db, aliases, accountId, handle, observedAt) {
  const lookup = orderedAliasLookup(aliases);
  return db.prepare(`UPDATE sh_hosts SET
      stationhead_account_id=COALESCE(stationhead_account_id,?),
      current_handle=COALESCE(?,current_handle),
      last_seen_at=MAX(last_seen_at,?)
    WHERE id=(
      SELECT host_id FROM sh_host_aliases
      WHERE ${lookup.predicate}
      ORDER BY ${lookup.priority} LIMIT 1
    )
    RETURNING id`)
    .bind(accountId, handle, observedAt, ...lookup.binds)
    .first();
}

async function upsertHostAliases(db, hostId, aliases, observedAt) {
  const values = aliases.map(() => '(?,?,?,?,?)').join(',');
  const binds = aliases.flatMap((alias) => [
    alias.type, alias.value, hostId, observedAt, observedAt,
  ]);
  await db.prepare(`INSERT INTO sh_host_aliases(
      alias_type,alias_value,host_id,first_seen_at,last_seen_at
    ) VALUES ${values}
    ON CONFLICT(alias_type,alias_value) DO UPDATE SET
      last_seen_at=MAX(sh_host_aliases.last_seen_at,excluded.last_seen_at)`)
    .bind(...binds)
    .run();
}

export async function resolveHost(db, source = {}, observedAt = Date.now()) {
  const accountId = integer(source.accountId ?? source.host_account_id);
  const handle = text(source.handle ?? source.host_handle);
  const legacyId = integer(source.legacyId ?? source.legacy_host_id);
  const aliases = uniqueAliases([
    accountId == null ? null : { type: 'stationhead_account_id', value: String(accountId) },
    legacyId == null ? null : { type: 'legacy_host_id', value: String(legacyId) },
    normalizedHandle(handle) ? { type: 'handle', value: normalizedHandle(handle) } : null,
  ]);
  if (!aliases.length) return null;

  const existing = await updateExistingHost(db, aliases, accountId, handle, observedAt);
  let hostId = Number(existing?.id);
  const canonicalKey = `${aliases[0].type}:${aliases[0].value}`;
  if (!Number.isFinite(hostId)) {
    await db.prepare(`INSERT OR IGNORE INTO sh_hosts(
      canonical_key,stationhead_account_id,current_handle,first_seen_at,last_seen_at
    ) VALUES(?,?,?,?,?)`).bind(canonicalKey, accountId, handle, observedAt, observedAt).run();
    const row = await db.prepare('SELECT id FROM sh_hosts WHERE canonical_key=?')
      .bind(canonicalKey).first();
    hostId = Number(row?.id);
    if (Number.isFinite(hostId)) {
      await db.prepare(`UPDATE sh_hosts SET
          stationhead_account_id=COALESCE(stationhead_account_id,?),
          current_handle=COALESCE(?,current_handle),
          last_seen_at=MAX(last_seen_at,?)
        WHERE id=?`).bind(accountId, handle, observedAt, hostId).run();
    }
  }
  if (!Number.isFinite(hostId)) return null;

  await upsertHostAliases(db, hostId, aliases, observedAt);
  return hostId;
}

export async function resolveTrack(db, source = {}, observedAt = Date.now()) {
  const isrc = normalizedIsrc(source.isrc);
  const spotifyId = text(source.spotifyId ?? source.spotify_id);
  const stationheadId = integer(source.stationheadId ?? source.stationhead_track_id);
  const legacyId = integer(source.legacyId ?? source.legacy_track_id);
  const title = text(source.title);
  const artist = text(source.artist ?? source.artist_name);
  const legacyName = normalizedLegacyTrack(title, artist);
  const aliases = uniqueAliases([
    isrc ? { type: 'isrc', value: isrc } : null,
    spotifyId ? { type: 'spotify_id', value: spotifyId } : null,
    stationheadId == null ? null : { type: 'stationhead_track_id', value: String(stationheadId) },
    legacyId == null ? null : { type: 'legacy_track_id', value: String(legacyId) },
    legacyName ? { type: 'legacy_name', value: legacyName } : null,
  ]);
  if (!aliases.length) return null;

  let trackId = await findAlias(db, 'sh_track_aliases', 'track_id', aliases);
  const canonicalKey = `${aliases[0].type}:${aliases[0].value}`;
  if (trackId == null) {
    await db.prepare(`INSERT OR IGNORE INTO sh_tracks(
      canonical_key,isrc,spotify_id,stationhead_track_id,title,artist,first_seen_at,last_seen_at
    ) VALUES(?,?,?,?,?,?,?,?)`).bind(
      canonicalKey, isrc, spotifyId, stationheadId, title, artist, observedAt, observedAt,
    ).run();
    const row = await db.prepare('SELECT id FROM sh_tracks WHERE canonical_key=?')
      .bind(canonicalKey).first();
    trackId = Number(row?.id);
  }
  if (!Number.isFinite(trackId)) return null;

  await db.prepare(`UPDATE sh_tracks SET
      isrc=COALESCE(isrc,?),spotify_id=COALESCE(spotify_id,?),
      stationhead_track_id=COALESCE(stationhead_track_id,?),
      title=COALESCE(title,?),artist=COALESCE(artist,?),
      last_seen_at=MAX(last_seen_at,?)
    WHERE id=?`).bind(
    isrc, spotifyId, stationheadId, title, artist, observedAt, trackId,
  ).run();
  await upsertAliases(db, 'sh_track_aliases', 'track_id', trackId, aliases, observedAt);
  return trackId;
}

async function activeSession(db, channelId) {
  return db.prepare(`SELECT * FROM sh_broadcast_sessions
    WHERE channel_id=? AND status='active' AND source='live_collector'
    ORDER BY last_observed_at DESC,id DESC LIMIT 1`).bind(channelId).first();
}

async function continueLiveSession(db, input) {
  return db.prepare(`UPDATE sh_broadcast_sessions SET
      station_id=COALESCE(station_id,?),host_id=COALESCE(host_id,?),
      broadcast_start_time=COALESCE(broadcast_start_time,?),
      last_observed_at=MAX(last_observed_at,?)
    WHERE id=(
      SELECT id FROM sh_broadcast_sessions
      WHERE channel_id=? AND status='active' AND source='live_collector'
      ORDER BY last_observed_at DESC,id DESC LIMIT 1
    )
      AND (? IS NULL OR station_id IS NULL OR station_id=?)
      AND (? IS NULL OR host_id IS NULL OR host_id=?)
      AND (? IS NULL OR broadcast_start_time IS NULL OR broadcast_start_time=?)
      AND ?-COALESCE(last_observed_at,0)<=?
    RETURNING id`).bind(
    input.stationId,
    input.hostId,
    input.broadcastStart,
    input.observedAt,
    input.channelId,
    input.stationId,
    input.stationId,
    input.hostId,
    input.hostId,
    input.broadcastStart,
    input.broadcastStart,
    input.observedAt,
    SESSION_GAP_MS,
  ).first();
}

async function endSession(db, sessionId, observedAt) {
  if (sessionId == null) return;
  await db.prepare(`UPDATE sh_broadcast_sessions SET
      last_observed_at=MAX(last_observed_at,?),ended_at=COALESCE(ended_at,?),status='ended'
    WHERE id=?`).bind(observedAt, observedAt, sessionId).run();
}

export async function resolveLiveSession(db, input) {
  const channelId = integer(input.channelId);
  if (channelId == null) throw new Error('minute facts require channel_id');
  const observedAt = integer(input.observedAt) ?? Date.now();
  const broadcasting = bool(input.isBroadcasting);
  const stationId = integer(input.stationId);
  const hostId = integer(input.hostId);
  const broadcastStart = timestampMs(input.broadcastStartTime);

  if (broadcasting !== 0) {
    const continued = await continueLiveSession(db, {
      channelId,
      stationId,
      hostId,
      broadcastStart,
      observedAt,
    });
    if (continued?.id != null) return Number(continued.id);
  }

  const active = await activeSession(db, channelId);
  if (broadcasting === 0) {
    await endSession(db, active?.id, observedAt);
    return null;
  }

  await endSession(db, active?.id, observedAt);
  const sessionKey = `live:${channelId}:${broadcastStart ?? observedAt}:${hostId ?? 0}:${stationId ?? 0}`;
  await db.prepare(`INSERT OR IGNORE INTO sh_broadcast_sessions(
      session_key,channel_id,station_id,host_id,broadcast_start_time,
      first_observed_at,last_observed_at,ended_at,status,source
    ) VALUES(?,?,?,?,?,?,?,NULL,'active','live_collector')`).bind(
    sessionKey, channelId, stationId, hostId, broadcastStart, observedAt, observedAt,
  ).run();
  const row = await db.prepare('SELECT id FROM sh_broadcast_sessions WHERE session_key=?')
    .bind(sessionKey).first();
  return row?.id == null ? null : Number(row.id);
}
