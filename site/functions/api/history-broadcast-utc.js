export const BROADCAST_SESSION_GAP_MS=6*60*60*1000;
export function broadcastSummarySql(source){
  return `WITH eligible AS (
  SELECT id,observed_at,listener_count,track_title,artist_name,likes,host_handle,source_note,
    lower(trim(source_note)) AS event_key,lower(trim(host_handle)) AS host_key
  FROM ${source}
  WHERE observed_at>=? AND observed_at<?
    AND lower(trim(host_handle))='sakurazaka46jp'
    AND source_note IS NOT NULL AND trim(source_note)<>''
), ordered AS (
  SELECT eligible.*,
    LAG(event_key) OVER (PARTITION BY host_key ORDER BY observed_at ASC,id ASC) AS previous_event_key,
    LAG(observed_at) OVER (PARTITION BY host_key ORDER BY observed_at ASC,id ASC) AS previous_observed_at
  FROM eligible
), segmented AS (
  SELECT ordered.*,
    SUM(CASE WHEN previous_observed_at IS NULL OR previous_event_key<>event_key
      OR observed_at-previous_observed_at>? THEN 1 ELSE 0 END)
    OVER (PARTITION BY host_key ORDER BY observed_at ASC,id ASC
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS session_number
  FROM ordered
), summaries AS (
  SELECT MIN(trim(source_note)) AS event_name,MIN(observed_at) AS started_at,
    MAX(observed_at) AS ended_at,
    strftime('%Y-%m-%dT%H:%M:%SZ',MIN(observed_at)/1000,'unixepoch') AS started_utc,
    strftime('%Y-%m-%dT%H:%M:%SZ',MAX(observed_at)/1000,'unixepoch') AS ended_utc,
    COUNT(*) AS sample_count,ROUND(AVG(listener_count),1) AS listener_avg,
    MIN(listener_count) AS listener_min,MAX(listener_count) AS listener_max,
    MAX(likes) AS likes_max,
    COUNT(DISTINCT CASE WHEN trim(COALESCE(track_title,''))<>''
      OR trim(COALESCE(artist_name,''))<>''
      THEN lower(trim(COALESCE(track_title,'')))||char(31)||lower(trim(COALESCE(artist_name,''))) END) AS distinct_tracks,
    MIN(trim(host_handle)) AS host_handle
  FROM segmented GROUP BY host_key,session_number
)
SELECT event_name,started_at,ended_at,started_utc,ended_utc,
  started_utc AS started_jst,ended_utc AS ended_jst,
  sample_count,listener_avg,listener_min,listener_max,likes_max,distinct_tracks,host_handle,1 AS has_data
FROM summaries
UNION ALL
SELECT NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0
WHERE NOT EXISTS(SELECT 1 FROM summaries)
ORDER BY started_at ASC`;
}
export const BROADCAST_SUMMARY_SQL=broadcastSummarySql('sh_legacy_history_rows');
export function parseBroadcastSummaryRows(resultRows){
  const rows=[];let hasData=false;
  for(const source of resultRows||[]){if(Number(source?.has_data)===1)hasData=true;if(source?.event_name==null)continue;const{has_data:ignored,...row}=source;rows.push(row);}
  return{rows,setupRequired:rows.length===0&&!hasData};
}
