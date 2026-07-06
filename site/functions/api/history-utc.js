import { onRequestGet as rankingHistory } from './history-ranking.js';
import { onRequestGet as rawHistory } from './history-raw.js';
import {
  BROADCAST_SESSION_GAP_MS,
  BROADCAST_SUMMARY_SQL,
  broadcastSummarySql,
  parseBroadcastSummaryRows,
} from './history-broadcast-utc.js';
import {
  SUMMARY_TABLES,
  combineSummaryRows,
  liveSummarySql,
  loadSummaryWithLive,
} from '../lib/history-summary.js';

export {
  BROADCAST_SESSION_GAP_MS,
  BROADCAST_SUMMARY_SQL,
  SUMMARY_TABLES,
  broadcastSummarySql,
  combineSummaryRows,
  liveSummarySql,
  loadSummaryWithLive,
  parseBroadcastSummaryRows,
};

const JSON_HEADERS={
  'content-type':'application/json; charset=utf-8',
  'cache-control':'public, max-age=300, s-maxage=900, stale-while-revalidate=3600',
  vary:'accept-encoding',
};
const json=(data,status=200,headers={})=>new Response(JSON.stringify(data),{status,headers:{...JSON_HEADERS,...headers}});
const cache=new Map(),CACHE_MAX=32;
const todayUtcString=()=>new Date().toISOString().slice(0,10);
const parseDateStart=(value,fallback)=>Date.parse(`${/^\d{4}-\d{2}-\d{2}$/.test(value||'')?value:fallback}T00:00:00Z`);

function promote(key,entry){cache.delete(key);cache.set(key,entry);}
export async function cachedHistoryLoad(key,ttlMs,loader,now=Date.now()){
  const cached=cache.get(key);
  if(cached?.expiresAt>now&&Object.hasOwn(cached,'value')){promote(key,cached);return cached.value;}
  if(cached?.pending){promote(key,cached);return cached.pending;}
  const entry=cached||{};
  entry.pending=Promise.resolve().then(loader).then((value)=>{entry.value=value;entry.expiresAt=Date.now()+ttlMs;return value;})
    .catch((error)=>{cache.delete(key);throw error;}).finally(()=>{entry.pending=null;});
  promote(key,entry);while(cache.size>CACHE_MAX)cache.delete(cache.keys().next().value);
  return entry.pending;
}
export function resetHistoryLoadCache(){cache.clear();}
async function snapshotResponse(response){return{body:await response.text(),status:response.status,statusText:response.statusText,headers:[...response.headers.entries()]};}
function restoreResponse(snapshot){return new Response(snapshot.body,{status:snapshot.status,statusText:snapshot.statusText,headers:snapshot.headers});}
export async function cachedLegacyHistoryResponse(key,ttlMs,loader){
  try{
    const snapshot=await cachedHistoryLoad(key,ttlMs,async()=>{
      const response=await loader(),value=await snapshotResponse(response);
      if(!response.ok){const error=new Error(`history response ${response.status}`);error.responseSnapshot=value;throw error;}
      return value;
    });
    return restoreResponse(snapshot);
  }catch(error){if(error?.responseSnapshot)return restoreResponse(error.responseSnapshot);throw error;}
}

async function loadBroadcastPayload(env,from,to){
  const fromTs=parseDateStart(from,'2024-06-01');
  const toTs=parseDateStart(to,todayUtcString())+86400000;
  let result,storageSource='lightweight';
  try{
    result=await env.DB.prepare(BROADCAST_SUMMARY_SQL).bind(fromTs,toTs,BROADCAST_SESSION_GAP_MS).all();
  }catch(error){
    if(!/no such table|no such view/i.test(String(error?.message||'')))throw error;
    result=await env.DB.prepare(broadcastSummarySql('sh_legacy_snapshots')).bind(fromTs,toTs,BROADCAST_SESSION_GAP_MS).all();
    storageSource='legacy-fallback';
  }
  const parsed=parseBroadcastSummaryRows(result.results||[]);
  return{
    ok:true,mode:'broadcasts',timezone:'UTC',from,to,rows:parsed.rows,
    setup_required:parsed.setupRequired,storage_source:storageSource,
    diagnostic:{imported_rows:null,imported_events:null,first_observed_utc:null,last_observed_utc:null},
  };
}
async function loadBroadcasts(env,from,to){
  const payload=await cachedHistoryLoad(`broadcasts:utc:v1:${from}:${to}`,30000,()=>loadBroadcastPayload(env,from,to));
  return json(payload,200,{'cache-control':'public, max-age=30, s-maxage=60, stale-while-revalidate=120'});
}
function rankingCacheKey(url){
  const from=url.searchParams.get('from')||'2024-06-01';
  const to=url.searchParams.get('to')||todayUtcString();
  const scope=url.searchParams.get('scope')==='all'?'all':'featured';
  const host=String(url.searchParams.get('host')||'').trim().slice(0,100).toLowerCase();
  const limit=Math.min(Math.max(Number(url.searchParams.get('limit'))||5000,20),10000);
  const version=String(url.searchParams.get('v')||'');
  return `ranking:utc:v1:${from}:${to}:${scope}:${host}:${limit}:${version}`;
}

export async function onRequestGet(context){
  const{request,env}=context;
  if(!env.DB)return json({ok:false,error:'DB binding missing'},500,{'cache-control':'no-store'});
  const url=new URL(request.url),mode=url.searchParams.get('mode')||'weekly';
  const from=url.searchParams.get('from')||'2024-06-01';
  const to=url.searchParams.get('to')||todayUtcString();
  try{
    if(Object.hasOwn(SUMMARY_TABLES,mode)){
      const summary=await cachedHistoryLoad(`summary:utc:v1:${mode}:${from}:${to}`,30000,()=>loadSummaryWithLive(env,mode,from,to));
      return json({ok:true,mode,timezone:'UTC',from,to,...summary},200,{'cache-control':'public, max-age=30, s-maxage=60, stale-while-revalidate=120'});
    }
    if(mode==='broadcasts')return loadBroadcasts(env,from,to);
    if(mode==='ranking')return cachedLegacyHistoryResponse(rankingCacheKey(url),60000,()=>rankingHistory(context));
    if(mode==='raw')return rawHistory(context);
    return json({ok:false,error:`unsupported history mode: ${mode}`},400,{'cache-control':'no-store'});
  }catch(error){return json({ok:false,error:error?.message||'history error'},500,{'cache-control':'no-store'});}
}
