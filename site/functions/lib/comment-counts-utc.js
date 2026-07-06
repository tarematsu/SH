import{num}from'./api-utils.js';
const MINUTE=60000,cursorsByDb=new WeakMap();
const timestampOf=(c,f)=>num(c?.chat_time_ms)??(num(c?.chat_time)!=null?num(c.chat_time)*1000:f);
const dayKey=(t)=>new Date(t).toISOString().slice(0,10);
const commentId=(c)=>num(c?.comment_id??c?.id);
function unique(comments){const map=new Map();for(const c of comments){const id=commentId(c);if(id!=null)map.set(id,c);}return[...map.entries()].sort((a,b)=>a[0]-b[0]);}
function cursorMap(db){let map=cursorsByDb.get(db);if(!map){map=new Map();cursorsByDb.set(db,map);}return map;}
export function resetCommentCountRuntimeState(db){if(db)cursorsByDb.delete(db);}
export async function saveCommentCounts(db,observedAt,data){
  const comments=Array.isArray(data?.comments)?data.comments:[];
  const stationId=num(data?.station_id??comments.find((c)=>num(c?.station_id)!=null)?.station_id);
  const knownLastId=num(data?.known_last_comment_id),reportedTotal=num(data?.total_count),ordered=unique(comments);
  const newestIncomingId=ordered.at(-1)?.[0]??null;
  if(stationId==null||ordered.length===0)return{accepted:0,total:reportedTotal??0,last_comment_id:knownLastId,velocityUpdated:false,skipped:true};
  const cursors=cursorMap(db),cachedLastId=num(cursors.get(stationId)),trustedLastId=Math.max(knownLastId??0,cachedLastId??0);
  if(newestIncomingId!=null&&trustedLastId>0&&newestIncomingId<=trustedLastId)return{accepted:0,total:reportedTotal??0,last_comment_id:trustedLastId,velocityUpdated:false,skipped:true,cursorHit:true};
  const state=await db.prepare(`SELECT last_comment_id,total_count,last_observed_at FROM sh_comment_state WHERE station_id=?`).bind(stationId).first();
  const lastId=num(state?.last_comment_id)??0;cursors.set(stationId,Math.max(cachedLastId??0,lastId));
  const fresh=ordered.filter(([id])=>id>lastId),derivedTotal=(num(state?.total_count)??0)+fresh.length;
  const total=reportedTotal==null?derivedTotal:Math.max(derivedTotal,reportedTotal);
  if(!fresh.length)return{accepted:0,total,last_comment_id:lastId||knownLastId,velocityUpdated:false,skipped:true};
  const minutes=new Map(),days=new Map();let lastObservedAt=num(state?.last_observed_at)??0;
  for(const[,comment]of fresh){const t=timestampOf(comment,observedAt),minute=Math.floor(t/MINUTE)*MINUTE;minutes.set(minute,(minutes.get(minute)||0)+1);const day=dayKey(t);days.set(day,(days.get(day)||0)+1);lastObservedAt=Math.max(lastObservedAt,t);}
  const statements=[];
  for(const[minute,count]of minutes)statements.push(db.prepare(`INSERT INTO sh_comment_minute_counts(station_id,bucket_start,comment_count) VALUES(?,?,?) ON CONFLICT(station_id,bucket_start) DO UPDATE SET comment_count=sh_comment_minute_counts.comment_count+excluded.comment_count`).bind(stationId,minute,count));
  for(const[day,count]of days)statements.push(db.prepare(`INSERT INTO sh_comment_daily_counts(station_id,day_key,comment_count) VALUES(?,?,?) ON CONFLICT(station_id,day_key) DO UPDATE SET comment_count=sh_comment_daily_counts.comment_count+excluded.comment_count`).bind(stationId,day,count));
  const newestAcceptedId=fresh.at(-1)[0];
  statements.push(db.prepare(`INSERT INTO sh_comment_state(station_id,last_comment_id,total_count,last_observed_at) VALUES(?,?,?,?) ON CONFLICT(station_id) DO UPDATE SET last_comment_id=MAX(sh_comment_state.last_comment_id,excluded.last_comment_id),total_count=MAX(sh_comment_state.total_count,excluded.total_count),last_observed_at=MAX(sh_comment_state.last_observed_at,excluded.last_observed_at)`).bind(stationId,newestAcceptedId,total,lastObservedAt));
  await db.batch(statements);cursors.set(stationId,newestAcceptedId);
  return{accepted:fresh.length,total,last_comment_id:newestAcceptedId,velocity:null,velocityUpdated:false};
}
