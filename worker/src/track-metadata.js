import { cleanSpotifyTitle } from './shared-utils.js';

const CACHE_TTL_MS=30*60*1000;
const RETRY_MS=24*60*60*1000;
const CACHE_MAX=16;
const queueCache=new Map();

export async function fetchTrackMetadata(track,config){
  const spotifyId=track?.spotify_id;if(!spotifyId)return null;
  const spotifyUrl=`https://open.spotify.com/track/${encodeURIComponent(spotifyId)}`;
  const spotify=await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(spotifyUrl)}`,{
    headers:{accept:'application/json'},signal:AbortSignal.timeout(config.requestTimeoutMs),
  }).then((response)=>response.ok?response.json():null).catch(()=>null);
  if(!spotify?.title)return null;
  const parsed=cleanSpotifyTitle(spotify.title);
  const title=parsed.title;
  const artist=String(spotify.author_name||spotify.author||'').trim()||parsed.artist||null;
  return {
    spotify_id:spotifyId,spotify_url:spotifyUrl,title,artist,
    display_title:title&&artist?`${title} — ${artist}`:parsed.displayTitle,
    thumbnail_url:spotify.thumbnail_url||null,source:'spotify_oembed',
    fetched_at:Date.now(),raw:{spotify},
  };
}

function completeMetadata(value,spotifyId=''){
  const title=String(value?.title||'').trim();
  const artist=String(value?.artist||'').trim();
  return Boolean(title&&artist&&title!==spotifyId&&artist!==spotifyId&&!/^JP[A-Z0-9]{8,}$/i.test(artist));
}

export function metadataNeedsRefresh(value,spotifyId='',now=Date.now()){
  if(completeMetadata(value,spotifyId))return false;
  const fetchedAt=Number(value?.fetched_at||0);
  return !Number.isFinite(fetchedAt)||fetchedAt<=0||now-fetchedAt>=RETRY_MS;
}

export function isrcMetadataRepairRows(rows,now=Date.now()){
  return (rows||[]).filter((row)=>completeMetadata(row,row?.spotify_id)).map((row)=>({
    spotify_id:String(row.spotify_id),title:String(row.title).trim(),artist:String(row.artist).trim(),
    display_title:`${String(row.title).trim()} — ${String(row.artist).trim()}`,
    thumbnail_url:row.thumbnail_url||null,
    spotify_url:`https://open.spotify.com/track/${encodeURIComponent(row.spotify_id)}`,
    source:'isrc_peer',fetched_at:now,
    raw:{resolved_from_spotify_id:row.peer_spotify_id||null,isrc:row.isrc||null},
  }));
}

async function repairMetadataFromIsrc(db,spotifyIds,now){
  if(!spotifyIds.length)return new Set();
  const placeholders=spotifyIds.map(()=>'?').join(',');
  const result=await db.prepare(`WITH ranked AS (
    SELECT candidate.spotify_id,candidate.isrc,peer.spotify_id AS peer_spotify_id,
      metadata.title,metadata.artist,metadata.thumbnail_url,
      ROW_NUMBER() OVER (
        PARTITION BY candidate.spotify_id
        ORDER BY peer.observed_at DESC,metadata.fetched_at DESC
      ) AS row_rank
    FROM sh_queue_items candidate
    JOIN sh_queue_items peer
      ON peer.isrc=candidate.isrc
     AND peer.spotify_id IS NOT NULL
     AND peer.spotify_id<>''
     AND peer.spotify_id<>candidate.spotify_id
    JOIN sh_track_metadata metadata ON metadata.spotify_id=peer.spotify_id
    WHERE candidate.spotify_id IN (${placeholders})
      AND candidate.isrc IS NOT NULL AND candidate.isrc<>''
      AND metadata.title IS NOT NULL AND metadata.title<>''
      AND metadata.artist IS NOT NULL AND metadata.artist<>''
      AND metadata.title<>metadata.spotify_id
      AND metadata.artist<>metadata.spotify_id
      AND metadata.artist NOT GLOB 'JP[A-Z0-9]*'
  ) SELECT spotify_id,isrc,peer_spotify_id,title,artist,thumbnail_url
    FROM ranked WHERE row_rank=1`).bind(...spotifyIds).all();
  const repairs=isrcMetadataRepairRows(result.results||[],now);
  if(repairs.length){
    await db.batch(repairs.map((row)=>db.prepare(`INSERT INTO sh_track_metadata(
      spotify_id,title,artist,display_title,thumbnail_url,spotify_url,source,fetched_at,raw_json
    ) VALUES(?,?,?,?,?,?,?,?,?)
    ON CONFLICT(spotify_id) DO UPDATE SET
      title=excluded.title,artist=excluded.artist,display_title=excluded.display_title,
      thumbnail_url=COALESCE(excluded.thumbnail_url,sh_track_metadata.thumbnail_url),
      spotify_url=excluded.spotify_url,source=excluded.source,
      fetched_at=MAX(excluded.fetched_at,sh_track_metadata.fetched_at),raw_json=excluded.raw_json`)
      .bind(row.spotify_id,row.title,row.artist,row.display_title,row.thumbnail_url,row.spotify_url,row.source,row.fetched_at,JSON.stringify(row.raw))));
  }
  return new Set(repairs.map((row)=>row.spotify_id));
}

const queueKey=(tracks)=>tracks.map((track)=>String(track.spotify_id)).sort().join(',');
function cached(key,now=Date.now()){
  const value=queueCache.get(key);
  if(!value||value.expiresAt<=now){if(value)queueCache.delete(key);return false;}
  queueCache.delete(key);queueCache.set(key,value);return true;
}
function markCached(key){
  queueCache.delete(key);queueCache.set(key,{expiresAt:Date.now()+CACHE_TTL_MS});
  while(queueCache.size>CACHE_MAX)queueCache.delete(queueCache.keys().next().value);
}
export function resetTrackMetadataQueueCache(){queueCache.clear();}

export async function enrichTracks(env,ingestFn,queue,observedAt,config){
  const unique=new Map();
  for(const track of queue?.tracks||[])if(track?.spotify_id)unique.set(track.spotify_id,track);
  const candidates=[...unique.values()];
  if(!candidates.length||(config.metadataLimit!=null&&config.metadataLimit<=0))return 0;
  const key=queueKey(candidates);if(cached(key))return 0;
  const spotifyIds=candidates.map((track)=>track.spotify_id);
  const placeholders=spotifyIds.map(()=>'?').join(',');
  const stored=await env.DB.prepare(`SELECT spotify_id,title,artist,fetched_at
    FROM sh_track_metadata WHERE spotify_id IN (${placeholders})`).bind(...spotifyIds).all();
  const now=Date.now();
  const settled=new Set((stored.results||[])
    .filter((item)=>!metadataNeedsRefresh(item,item.spotify_id,now))
    .map((item)=>item.spotify_id));
  const unresolved=spotifyIds.filter((spotifyId)=>!settled.has(spotifyId));
  if(unresolved.length){
    const repaired=await repairMetadataFromIsrc(env.DB,unresolved,now);
    for(const spotifyId of repaired)settled.add(spotifyId);
  }
  const missingAll=candidates.filter((track)=>!settled.has(track.spotify_id));
  if(!missingAll.length){markCached(key);return 0;}
  const limit=config.metadataLimit??3;
  const missing=missingAll.slice(0,limit),metadata=[];
  for(const track of missing){const item=await fetchTrackMetadata(track,config);if(item)metadata.push(item);}
  if(metadata.length)await ingestFn(env,'track_metadata',{tracks:metadata},observedAt);
  const attempted=new Set(metadata.map((item)=>item.spotify_id));
  if(missingAll.length<=limit&&missing.every((track)=>attempted.has(track.spotify_id)))markCached(key);
  else queueCache.delete(key);
  return metadata.length;
}
