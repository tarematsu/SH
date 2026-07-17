import { payloadHash } from '../../site/functions/lib/ingest-claim.js';
import { bool, num, rawJson, text } from '../../site/functions/lib/api-utils.js';

const SNAPSHOT_ANALYSIS = Symbol.for('stationhead.snapshot.analysis');
const SNAPSHOT_CHECKPOINT_MS = 5 * 60_000;

function snapshotRawPayload(data) {
  const presentation = data?.presentation;
  if (presentation && typeof presentation === 'object') {
    const currentStation = presentation.current_station || {};
    const owner = currentStation.owner || {};
    return {
      description: text(presentation.description || currentStation.status),
      artist_name: text(presentation.artist_name),
      accent_color: text(presentation.accent_color),
      images: {
        medium: { url: text(presentation.images?.medium?.url) },
        logo: { medium: { url: text(presentation.images?.logo?.medium?.url) } },
      },
      current_station: {
        status: text(currentStation.status),
        owner: {
          thumbnail: { url: text(owner.thumbnail?.url) },
          medium: { url: text(owner.medium?.url) },
        },
      },
    };
  }
  return null;
}

function reportedStreamCount(data) {
  const value = num(data?.current_stream_count);
  return value != null && value >= 0 ? value : null;
}

function snapshotFrame(data) {
  const streamCount = reportedStreamCount(data);
  return {
    channelId: num(data?.channel_id),
    channelAlias: text(data?.channel_alias),
    channelName: text(data?.channel_name),
    stationId: num(data?.station_id),
    isLaunched: bool(data?.is_launched),
    isBroadcasting: bool(data?.is_broadcasting),
    chatStatus: text(data?.chat_status),
    listenerCount: num(data?.listener_count),
    onlineMemberCount: num(data?.online_member_count),
    totalMemberCount: num(data?.total_member_count),
    guestCount: num(data?.guest_count),
    cumulativeListenerCount: num(data?.total_listens),
    streamGoal: num(data?.stream_goal),
    streamCount,
    hostAccountId: num(data?.host_account_id),
    hostHandle: text(data?.host_handle),
    broadcastStartTime: num(data?.broadcast_start_time),
    metadata: snapshotRawPayload(data),
  };
}

function snapshotHashPayload(frame) {
  return {
    channel_id: frame.channelId,
    station_id: frame.stationId,
    is_launched: frame.isLaunched,
    is_broadcasting: frame.isBroadcasting,
    chat_status: frame.chatStatus,
    listener_count: frame.listenerCount,
    online_member_count: frame.onlineMemberCount,
    total_member_count: frame.totalMemberCount,
    guest_count: frame.guestCount,
    cumulative_listener_count: frame.cumulativeListenerCount,
    reported_stream_count: frame.streamCount,
    stream_goal: frame.streamGoal,
    host_account_id: frame.hostAccountId,
    host_handle: frame.hostHandle,
    broadcast_start_time: frame.broadcastStartTime,
    metadata: frame.metadata,
  };
}

export async function prepareSnapshotAnalysis(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  const frame = snapshotFrame(snapshot);
  return {
    frame,
    hash: await payloadHash(snapshotHashPayload(frame)),
  };
}

export function restoreSnapshotAnalysis(snapshot, analysis) {
  if (!snapshot || !analysis?.frame || typeof analysis.hash !== 'string') return snapshot;
  Object.defineProperty(snapshot, SNAPSHOT_ANALYSIS, { value: analysis });
  return snapshot;
}

async function fallbackSnapshot(db, observedAt, data) {
  const { saveLeanSnapshot } = await import('../../site/functions/lib/d1-lean-ingest.js');
  return saveLeanSnapshot(db, observedAt, data);
}

export async function savePreparedSnapshot(db, observedAt, data) {
  const analysis = data?.[SNAPSHOT_ANALYSIS];
  if (!analysis?.frame || typeof analysis.hash !== 'string') {
    return fallbackSnapshot(db, observedAt, data);
  }
  const frame = analysis.frame;
  const channelKey = String(frame.channelId ?? `station:${frame.stationId ?? 0}`);
  const current = await db.prepare(`SELECT payload_hash,last_snapshot_at
    FROM sh_snapshot_current WHERE channel_key=?`).bind(channelKey).first();
  if (current?.payload_hash === analysis.hash
      && observedAt - Number(current.last_snapshot_at || 0) < SNAPSHOT_CHECKPOINT_MS) {
    return {
      inserted: false,
      skipped: true,
      reportedStreamCount: frame.streamCount,
      reported_stream_count: frame.streamCount,
    };
  }

  const common = [
    observedAt, frame.channelId, frame.channelAlias, frame.channelName, frame.stationId,
    frame.isLaunched, frame.isBroadcasting, frame.chatStatus,
    frame.listenerCount, frame.onlineMemberCount, frame.totalMemberCount,
    frame.guestCount, frame.cumulativeListenerCount, frame.streamGoal,
    frame.streamCount, null, frame.hostAccountId, frame.hostHandle,
    frame.broadcastStartTime,
  ];
  const velocityBinds = [frame.stationId, observedAt - 120_000, observedAt];
  await db.batch([
    db.prepare(`INSERT INTO sh_channel_snapshots (
      observed_at,channel_id,channel_alias,channel_name,station_id,
      is_launched,is_broadcasting,chat_status,listener_count,online_member_count,
      total_member_count,guest_count,total_listens,stream_goal,current_stream_count,
      validated_stream_count,host_account_id,host_handle,broadcast_start_time,comment_velocity,raw_json
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,(
      SELECT COALESCE(SUM(comment_count),0) FROM sh_comment_minute_counts
      WHERE station_id=? AND bucket_start>=? AND bucket_start<=?
    ),?)`).bind(...common, ...velocityBinds, rawJson(frame.metadata)),
    db.prepare(`INSERT INTO sh_snapshot_current(
        channel_key,payload_hash,last_snapshot_at,last_stream_count,last_stream_at,updated_at
      ) VALUES(?,?,?,?,?,?) ON CONFLICT(channel_key) DO UPDATE SET
      payload_hash=excluded.payload_hash,last_snapshot_at=excluded.last_snapshot_at,
      last_stream_count=NULL,last_stream_at=NULL,
      updated_at=excluded.updated_at
      WHERE excluded.last_snapshot_at>=COALESCE(sh_snapshot_current.last_snapshot_at,0)`)
      .bind(channelKey, analysis.hash, observedAt, null, null, Date.now()),
  ]);
  return {
    inserted: true,
    skipped: false,
    reportedStreamCount: frame.streamCount,
    reported_stream_count: frame.streamCount,
  };
}
