import { bestText, canonical, cleanText, looksLikeId, looksLikePlaceholder } from './track-history-text.js';

const ID_FIELDS = [['isrc','isrc'],['spotify_id','spotify'],['apple_music_id','apple'],['stationhead_track_id','stationhead'],['queue_track_id','queue']];
const positiveCount=(v)=>Number.isFinite(Number(v))&&Number(v)>0?Number(v):1;
const finiteTime=(v,f=null)=>Number.isFinite(Number(v))?Number(v):f;
const normalizedId=(field,v)=>{const id=cleanText(v);return !id||looksLikePlaceholder(id)?null:field==='isrc'?id.toUpperCase():id;};
const rowIdentifiers=(row)=>ID_FIELDS.flatMap(([field,prefix])=>{const value=normalizedId(field,row?.[field]);return value?[{field,prefix,value,token:`${prefix}:${value}`}]:[];});

function unionFind(size){
  const parent=Array.from({length:size},(_,i)=>i),rank=new Uint8Array(size);
  const find=(v)=>{let root=v;while(parent[root]!==root)root=parent[root];while(parent[v]!==v){const next=parent[v];parent[v]=root;v=next;}return root;};
  const union=(left,right)=>{let a=find(left),b=find(right);if(a===b)return a;if(rank[a]<rank[b])[a,b]=[b,a];parent[b]=a;if(rank[a]===rank[b])rank[a]+=1;return a;};
  return {find,union};
}

function mergeAliases(entries,uf){
  const owners=new Map();
  entries.forEach((entry,index)=>{
    const aliases=entry.identifiers.map((item)=>`${entry.playDate}|id:${item.token}`);
    if(entry.titleResolved&&entry.artist)aliases.push(`${entry.playDate}|name:${canonical(entry.title)}|artist:${canonical(entry.artist)}`);
    for(const alias of aliases){const owner=owners.get(alias);if(owner==null)owners.set(alias,index);else uf.union(index,owner);}
  });
}

const firstValue=(values)=>values?.size?values.values().next().value:null;

function aggregateEntries(entries,uf){
  const merged=new Map();
  entries.forEach((entry,index)=>{
    const root=uf.find(index),playCount=positiveCount(entry.row.play_count);
    const first=finiteTime(entry.row.first_played_at,finiteTime(entry.row.played_at));
    const last=finiteTime(entry.row.last_played_at,finiteTime(entry.row.played_at));
    let current=merged.get(root);
    if(!current){current={play_date:entry.playDate,title:entry.titleResolved?entry.title:'曲情報なし',artist:entry.artist,spotify_url:entry.row.spotify_url||null,play_count:0,first_played_at:null,last_played_at:null,ids:new Map(ID_FIELDS.map(([field])=>[field,new Set()]))};merged.set(root,current);}
    current.play_count+=playCount;
    if(first!=null)current.first_played_at=current.first_played_at==null?first:Math.min(current.first_played_at,first);
    if(last!=null)current.last_played_at=current.last_played_at==null?last:Math.max(current.last_played_at,last);
    if(!current.spotify_url&&entry.row.spotify_url)current.spotify_url=entry.row.spotify_url;
    for(const id of entry.identifiers)current.ids.get(id.field).add(id.value);
  });
  return [...merged.values()].map((current)=>{
    const isrc=firstValue(current.ids.get('isrc')),spotifyId=firstValue(current.ids.get('spotify_id')),appleMusicId=firstValue(current.ids.get('apple_music_id')),stationheadTrackId=firstValue(current.ids.get('stationhead_track_id')),queueTrackId=firstValue(current.ids.get('queue_track_id'));
    const strongest=isrc?`isrc:${isrc}`:spotifyId?`spotify:${spotifyId}`:appleMusicId?`apple:${appleMusicId}`:stationheadTrackId?`stationhead:${stationheadTrackId}`:queueTrackId?`queue:${queueTrackId}`:`name:${canonical(current.title)}|artist:${canonical(current.artist)}`;
    return {play_date:current.play_date,track_key:strongest,title:current.title,artist:current.artist,spotify_id:spotifyId,apple_music_id:appleMusicId,isrc,stationhead_track_id:stationheadTrackId,queue_track_id:queueTrackId,spotify_url:current.spotify_url,play_count:current.play_count,first_played_at:current.first_played_at,last_played_at:current.last_played_at,source_ids:[...current.ids.get('spotify_id'),...current.ids.get('apple_music_id'),...current.ids.get('isrc')]};
  });
}

export function mergeTrackRows(rows){
  const entries=(rows||[]).map((row)=>{const title=bestText(row.title,row.raw_title,row.display_title,row.spotify_id,row.isrc),artist=bestText(row.artist,row.raw_artist);return {row,playDate:row.play_date,title:title||'曲情報なし',titleResolved:Boolean(title&&title!=='曲情報なし'&&!looksLikeId(title)),artist,identifiers:rowIdentifiers(row)};});
  if(!entries.length)return [];
  const uf=unionFind(entries.length);mergeAliases(entries,uf);
  return aggregateEntries(entries,uf).sort((a,b)=>b.play_date.localeCompare(a.play_date)||b.play_count-a.play_count||a.title.localeCompare(b.title,'ja'));
}
