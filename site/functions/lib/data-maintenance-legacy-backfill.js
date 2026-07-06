const BATCH=1000;
export async function backfillLegacySamples(db,lastId){
  const boundary=await db.prepare(`SELECT MAX(id) AS batch_end,COUNT(*) AS batch_count FROM (SELECT id FROM sh_legacy_snapshots WHERE id>? ORDER BY id ASC LIMIT ?)`)
    .bind(lastId,BATCH).first();
  const end=Number(boundary?.batch_end||0),count=Number(boundary?.batch_count||0);
  if(!end||end<=lastId)return {lastLegacyId:lastId,migrated:0,complete:true};
  const host=`lower(trim(host_handle))`;
  const track=`lower(trim(COALESCE(track_title,'')))||char(31)||lower(trim(COALESCE(artist_name,'')))`;
  const broadcast=`lower(trim(source_note))||char(31)||lower(trim(COALESCE(host_handle,'')))`;
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO sh_legacy_hosts(host_key,handle) SELECT ${host},MIN(host_handle) FROM sh_legacy_snapshots WHERE id>? AND id<=? AND host_handle IS NOT NULL AND trim(host_handle)<>'' GROUP BY ${host}`).bind(lastId,end),
    db.prepare(`INSERT OR IGNORE INTO sh_legacy_tracks(track_key,title,artist_name) SELECT ${track},MIN(track_title),MIN(artist_name) FROM sh_legacy_snapshots WHERE id>? AND id<=? AND (trim(COALESCE(track_title,''))<>'' OR trim(COALESCE(artist_name,''))<>'') GROUP BY ${track}`).bind(lastId,end),
    db.prepare(`INSERT OR IGNORE INTO sh_legacy_broadcasts(broadcast_key,event_name,host_id) SELECT ${broadcast},MIN(l.source_note),MIN(h.id) FROM sh_legacy_snapshots l LEFT JOIN sh_legacy_hosts h ON h.host_key=lower(trim(l.host_handle)) WHERE l.id>? AND l.id<=? AND l.source_note IS NOT NULL AND trim(l.source_note)<>'' GROUP BY ${broadcast}`).bind(lastId,end),
    db.prepare(`INSERT OR IGNORE INTO sh_legacy_samples(legacy_id,observed_at,observed_jst,listener_count,total_stream_count,track_id,likes,comment_velocity,host_id,total_member_count,broadcast_id,quality_score,quality_flags)
      SELECT l.id,l.observed_at,l.observed_jst,l.listener_count,l.total_stream_count,t.id,l.likes,l.comment_velocity,h.id,l.total_member_count,b.id,COALESCE(l.quality_score,1),COALESCE(l.quality_flags,'[]')
      FROM sh_legacy_snapshots l LEFT JOIN sh_legacy_hosts h ON h.host_key=lower(trim(l.host_handle)) LEFT JOIN sh_legacy_tracks t ON t.track_key=(lower(trim(COALESCE(l.track_title,'')))||char(31)||lower(trim(COALESCE(l.artist_name,'')))) LEFT JOIN sh_legacy_broadcasts b ON b.broadcast_key=(lower(trim(l.source_note))||char(31)||lower(trim(COALESCE(l.host_handle,'')))) WHERE l.id>? AND l.id<=?`).bind(lastId,end),
  ]);
  return {lastLegacyId:end,migrated:count,complete:false};
}
