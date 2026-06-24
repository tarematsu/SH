const H={'content-type':'application/json; charset=utf-8','cache-control':'public, max-age=60, s-maxage=300'};
const out=(v,s=200)=>new Response(JSON.stringify(v),{status:s,headers:H});
const day=()=>new Date(Date.now()+32400000).toISOString().slice(0,10);
const valid=v=>/^\d{4}-\d{2}-\d{2}$/.test(v||'');
const ts=v=>Date.parse(`${v}T00:00:00+09:00`);
export async function onRequestGet({request,env}){
 if(!env.DB)return out({ok:false,error:'DB binding missing'},500);
 const u=new URL(request.url),from=valid(u.searchParams.get('from'))?u.searchParams.get('from'):'2024-05-01',to=valid(u.searchParams.get('to'))?u.searchParams.get('to'):day();
 const a=ts(from),b=ts(to)+86400000,limit=Math.min(Math.max(+u.searchParams.get('limit')||10000,100),20000);
 if(!Number.isFinite(a)||!Number.isFinite(b)||b<=a)return out({ok:false,error:'invalid date range'},400);
 try{
  const r=await env.DB.prepare(`WITH p AS(
   SELECT q.*,q.start_time+COALESCE((SELECT SUM(COALESCE(x.duration_ms,0)) FROM sh_queue_items x WHERE x.station_id=q.station_id AND x.start_time=q.start_time AND x.position<q.position),0) played_at
   FROM sh_queue_items q WHERE q.start_time>=? AND q.start_time<?
  )
  SELECT strftime('%Y-%m-%d',p.played_at/1000,'unixepoch','+9 hours') play_date,
   COALESCE(NULLIF(p.spotify_id,''),NULLIF(p.isrc,''),'track:'||COALESCE(p.stationhead_track_id,p.queue_track_id,p.position)) track_key,
   COALESCE(MAX(NULLIF(m.title,'')),MAX(NULLIF(m.display_title,'')),MAX(NULLIF(p.spotify_id,'')),MAX(NULLIF(p.isrc,'')),'曲情報なし') title,
   MAX(NULLIF(m.artist,'')) artist,MAX(NULLIF(m.spotify_url,'')) spotify_url,COUNT(*) play_count,
   MIN(p.played_at) first_played_at,MAX(p.played_at) last_played_at
  FROM p LEFT JOIN sh_track_metadata m ON m.spotify_id=p.spotify_id
  WHERE p.played_at>=? AND p.played_at<?
  GROUP BY play_date,track_key ORDER BY play_date DESC,play_count DESC,title ASC LIMIT ?`)
   .bind(a-604800000,b,a,b,limit+1).all();
  const all=r.results||[],truncated=all.length>limit;
  return out({ok:true,mode:'tracks',from,to,rows:truncated?all.slice(0,limit):all,truncated,method:'queue_timeline'});
 }catch(e){
  if(/no such table|no such column/i.test(String(e?.message||'')))return out({ok:true,mode:'tracks',from,to,rows:[],setup_required:true});
  return out({ok:false,error:e?.message||'track history error'},500);
 }
}
