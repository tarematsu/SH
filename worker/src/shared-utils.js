export const jsonResponse=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json; charset=utf-8'}});
export const jsonNoStoreResponse=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});
export const normalizeBearer=(value)=>String(value||'').replace(/^Bearer\s+/i,'').trim();

export function jwtExpiryMs(token){
  try{
    const part=String(token||'').split('.')[1];if(!part)return 0;
    const normalized=part.replace(/-/g,'+').replace(/_/g,'/');
    const padded=normalized.padEnd(Math.ceil(normalized.length/4)*4,'=');
    return Number(JSON.parse(atob(padded)).exp||0)*1000;
  }catch{return 0;}
}

export function finiteNumber(value){
  if(value===undefined||value===null||value==='')return null;
  const n=Number(value);return Number.isFinite(n)?n:null;
}

export function positiveNumber(value,fallback){
  const n=Number(value??fallback);return Number.isFinite(n)&&n>0?n:fallback;
}

export async function timedFetch(url,options,timeoutMs){
  return fetch(url,{...(options||{}),signal:AbortSignal.timeout(timeoutMs)});
}

export function highResolutionArtwork(url){
  return url?String(url).replace(/\/\d+x\d+bb\./,'/600x600bb.').replace(/\/\d+x\d+-\d+\./,'/600x600-75.'):null;
}

export function cleanSpotifyTitle(rawTitle){
  const cleaned=String(rawTitle||'').replace(/\s*\|\s*Spotify\s*$/i,'').trim();
  const parts=cleaned.split(/\s+[—–]\s+/);
  return {title:parts[0]||rawTitle||null,artist:parts.length>1?parts.slice(1).join(' — '):null,displayTitle:cleaned||rawTitle||null};
}

function commentIdentity(comment){
  if(comment?.comment_id!=null)return `numeric:${comment.comment_id}`;
  const raw=String(comment?.id??'').trim();return raw?`raw:${raw}`:null;
}

export function normalizeComments(payload,stationId,{finite}={}){
  const toFinite=finite||finiteNumber;
  const candidates=[payload,payload?.items,payload?.data?.items,payload?.chats?.items,payload?.chats];
  const items=candidates.find(Array.isArray)||[];
  const normalized=items.map((chat)=>{
    const rawId=chat?.comment_id??chat?.id;
    return {
      comment_id:toFinite(rawId),id:rawId,
      station_id:toFinite(chat?.station_id??stationId),
      account_id:toFinite(chat?.account_id??chat?.account?.id),
      handle:chat?.account?.handle??null,text:chat?.text??null,text_with_xml:chat?.text_with_xml??null,
      chat_time:toFinite(chat?.chat_time),chat_time_ms:toFinite(chat?.chat_time_ms),
      all_access_chat:chat?.all_access_chat??null,boost_chat:chat?.boost_chat??null,
      followers:toFinite(chat?.account?.followers),following:toFinite(chat?.account?.following),
      active_stream_days:toFinite(chat?.active_stream_days??chat?.account?.active_stream_days),
      emoji:chat?.account?.emoji??null,raw:chat,
    };
  }).filter((comment)=>comment.comment_id!=null||comment.id!=null);
  const seen=new Set(),out=[];
  for(const comment of normalized){const id=commentIdentity(comment);if(!id||seen.has(id))continue;seen.add(id);out.push(comment);}
  return out;
}
