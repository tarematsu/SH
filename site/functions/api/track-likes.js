const H={"content-type":"application/json; charset=utf-8","cache-control":"public, max-age=300, s-maxage=900, stale-while-revalidate=3600"};
const out=(v,s=200)=>new Response(JSON.stringify(v),{status:s,headers:H});
const valid=v=>/^\d{4}-\d{2}-\d{2}$/.test(v||'');
const ts=v=>Date.parse(`${v}T00:00:00Z`);

export async function onRequestGet({request,env}){
  if(!env.DB)return out({ok:false,error:'DB binding missing'},500);
  const url=new URL(request.url);
  const from=valid(url.searchParams.get('from'))?url.searchParams.get('from'):'2024-05-01';
  const to=valid(url.searchParams.get('to'))?url.searchParams.get('to'):new Date().toISOString().slice(0,10);
  const fromTs=ts(from),toTs=ts(to)+86400000;
  if(!Number.isFinite(fromTs)||!Number.isFinite(toTs)||toTs<=fromTs)return out({ok:false,error:'invalid date range'},400);
  try{
    const current=await env.DB.prepare(`WITH timed AS (
      SELECT q.*,
        q.start_time + COALESCE(SUM(COALESCE(q.duration_ms,0)) OVER (
          PARTITION BY q.station_id,q.start_time ORDER BY q.position
          ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
        ),0) AS played_at
      FROM sh_queue_items q
      WHERE q.start_time>=? AND q.start_time<?
    )
    SELECT
      strftime('%Y-%m-%d',played_at/1000,'unixepoch') AS play_date,
      spotify_id,apple_music_id,isrc,stationhead_track_id,queue_track_id,
      NULL AS title,NULL AS artist,
      MAX(COALESCE(
        bite_count,
        CAST(json_extract(raw_json,'$.bite_count') AS INTEGER),
        CAST(json_extract(raw_json,'$.track.bite_count') AS INTEGER),
        CAST(json_extract(raw_json,'$.like_count') AS INTEGER),
        CAST(json_extract(raw_json,'$.likes') AS INTEGER),
        CAST(json_extract(raw_json,'$.いいね数') AS INTEGER)
      )) AS like_count,
      MAX(observed_at) AS observed_at,
      'collector' AS source
    FROM timed
    WHERE played_at>=? AND played_at<?
    GROUP BY play_date,spotify_id,apple_music_id,isrc,stationhead_track_id,queue_track_id
    HAVING like_count IS NOT NULL`).bind(fromTs-604800000,toTs,fromTs,toTs).all();

    let historical=[];
    try{
      const result=await env.DB.prepare(`SELECT
        strftime('%Y-%m-%d',observed_at/1000,'unixepoch') AS play_date,
        NULL AS spotify_id,NULL AS apple_music_id,NULL AS isrc,NULL AS stationhead_track_id,NULL AS queue_track_id,
        track_title AS title,artist,like_count,observed_at,'sheet' AS source
      FROM sh_track_like_history
      WHERE observed_at>=? AND observed_at<?
      ORDER BY observed_at ASC`).bind(fromTs,toTs).all();
      historical=result.results||[];
    }catch(error){
      if(!/no such table/i.test(String(error?.message||'')))throw error;
    }

    return out({ok:true,from,to,rows:[...(current.results||[]),...historical]});
  }catch(error){
    return out({ok:false,error:error?.message||'track likes error'},500);
  }
}
