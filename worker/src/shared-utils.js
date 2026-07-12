import {
  cleanSpotifyTitle,
  finiteNumber,
  highResolutionArtwork,
  normalizeComments,
  positiveNumber,
} from 'sh-shared';

export { cleanSpotifyTitle, finiteNumber, highResolutionArtwork, normalizeComments, positiveNumber };

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

export async function timedFetch(url,options,timeoutMs){
  return fetch(url,{...(options||{}),signal:AbortSignal.timeout(timeoutMs)});
}
