const encoder = new TextEncoder();

export function minuteBucket(value) {
  return Math.floor(Number(value) / 60000) * 60000;
}

export function hourBucket(value) {
  return Math.floor(Number(value) / 3600000) * 3600000;
}

function inferCollectorKind(collectorId) {
  const value = String(collectorId || '').toLowerCase();
  if (/cloudflare|worker/.test(value)) return 'cloud';
  if (value && value !== 'unknown') return 'local';
  return 'unknown';
}

function defaultPriority(kind) {
  if (kind === 'cloud') return 100;
  if (kind === 'local') return 70;
  return 50;
}

export function sourceIdentity(body, defaults = {}) {
  const collectorId = String(body?.collector_id || defaults.collectorId || 'unknown').trim().slice(0, 200) || 'unknown';
  const inferredKind = inferCollectorKind(collectorId);
  const collectorKind = String(body?.collector_kind || defaults.collectorKind || inferredKind).trim().slice(0, 50) || inferredKind;
  const parsedPriority = Number(body?.source_priority ?? defaults.sourcePriority ?? defaultPriority(collectorKind));
  const sourcePriority = Number.isFinite(parsedPriority)
    ? Math.max(0, Math.min(1000, Math.trunc(parsedPriority)))
    : defaultPriority(collectorKind);
  return { collectorId, collectorKind, sourcePriority };
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`);
  return `{${entries.join(',')}}`;
}

export async function payloadHash(value) {
  const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(canonical(value)));
  return [...new Uint8Array(bytes)].map((part) => part.toString(16).padStart(2, '0')).join('');
}

async function logConflict(db, existing, incoming, resolution, metadata) {
  await db.prepare(`INSERT INTO sh_ingest_conflicts (
      dedupe_key,data_type,canonical_collector_id,canonical_priority,canonical_hash,
      incoming_collector_id,incoming_priority,incoming_hash,observed_at,detected_at,
      resolution,metadata_json
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(
      incoming.dedupeKey,
      incoming.dataType,
      existing?.collector_id || null,
      existing?.source_priority ?? null,
      existing?.payload_hash || null,
      incoming.collectorId,
      incoming.sourcePriority,
      incoming.hash,
      incoming.observedAt,
      Date.now(),
      resolution,
      JSON.stringify(metadata || null),
    ).run();
}

export async function claimWrite(db, options) {
  const incoming = {
    dedupeKey: String(options.dedupeKey || '').slice(0, 500),
    dataType: String(options.dataType || 'unknown').slice(0, 100),
    collectorId: String(options.collectorId || 'unknown').slice(0, 200),
    collectorKind: String(options.collectorKind || 'unknown').slice(0, 50),
    sourcePriority: Number(options.sourcePriority ?? 0),
    observedAt: Number(options.observedAt || Date.now()),
    hash: options.hash || await payloadHash(options.payload),
  };
  if (!incoming.dedupeKey) throw new Error('dedupe key is required');

  let existing;
  try {
    existing = await db.prepare(`SELECT collector_id,collector_kind,source_priority,
      observed_at,payload_hash FROM sh_ingest_claims WHERE dedupe_key=?`)
      .bind(incoming.dedupeKey).first();
  } catch (error) {
    if (/no such table/i.test(String(error?.message || ''))) {
      return { accepted: true, duplicate: false, reason: 'claims_not_installed', hash: incoming.hash };
    }
    throw error;
  }

  if (existing?.payload_hash === incoming.hash) {
    return { accepted: false, duplicate: true, reason: 'same_payload', hash: incoming.hash, existing };
  }

  const replace = !existing
    || incoming.sourcePriority > Number(existing.source_priority || 0)
    || (
      incoming.sourcePriority === Number(existing.source_priority || 0)
      && incoming.observedAt >= Number(existing.observed_at || 0)
    );

  if (!replace) {
    await logConflict(db, existing, incoming, 'kept_higher_priority', options.metadata).catch(() => {});
    return { accepted: false, duplicate: false, reason: 'lower_priority', hash: incoming.hash, existing };
  }

  const now = Date.now();
  const result = await db.prepare(`INSERT INTO sh_ingest_claims (
      dedupe_key,data_type,collector_id,collector_kind,source_priority,
      observed_at,payload_hash,first_seen_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(dedupe_key) DO UPDATE SET
      data_type=excluded.data_type,
      collector_id=excluded.collector_id,
      collector_kind=excluded.collector_kind,
      source_priority=excluded.source_priority,
      observed_at=excluded.observed_at,
      payload_hash=excluded.payload_hash,
      updated_at=excluded.updated_at
    WHERE excluded.source_priority>sh_ingest_claims.source_priority
       OR (excluded.source_priority=sh_ingest_claims.source_priority
           AND excluded.observed_at>=sh_ingest_claims.observed_at)`)
    .bind(
      incoming.dedupeKey,
      incoming.dataType,
      incoming.collectorId,
      incoming.collectorKind,
      incoming.sourcePriority,
      incoming.observedAt,
      incoming.hash,
      now,
      now,
    ).run();

  if (existing && existing.payload_hash !== incoming.hash) {
    await logConflict(db, existing, incoming, 'replaced_by_priority', options.metadata).catch(() => {});
  }

  const accepted = Number(result?.meta?.changes || 0) > 0;
  return {
    accepted,
    duplicate: false,
    reason: accepted ? (existing ? 'replaced' : 'claimed') : 'lost_race',
    hash: incoming.hash,
    existing,
  };
}
