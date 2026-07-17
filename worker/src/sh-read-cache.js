const ORIGIN='https://production1.stationhead.com';
const PREFIX=`${ORIGIN}/station/`;
const MAX=32;
const MARK=Symbol.for('sh-monitor.sh-read-cache');
const NULL_BODY_STATUS=new Set([101,204,205,304]);

function cacheable(input,init,now){
  const raw=typeof input==='string'?input:input instanceof URL?input.toString():input?.url;
  if(!raw||!String(raw).startsWith(PREFIX))return null;
  let url;try{url=new URL(raw);}catch{return null;}
  if(url.origin!==ORIGIN)return null;
  const method=String(init?.method||input?.method||'GET').toUpperCase();
  const chat=method==='GET'&&/\/station\/[^/]+\/chatHistory\/?$/i.test(url.pathname);
  const guest=method==='POST'&&/\/station\/handle\/[^/]+\/guest\/?$/i.test(url.pathname);
  if(!chat&&!guest)return null;
  let body='';
  if(guest){
    if(init?.body==null){if(typeof Request==='function'&&input instanceof Request)return null;}
    else if(typeof init.body==='string')body=init.body;else return null;
    if(body.trim()&&body.trim()!=='{}')return null;
  }
  const headers=new Headers(init?.headers||input?.headers||undefined);
  return {minute:Math.floor(now/60000),key:[method,url.toString(),body,headers.get('sth-device-uid')||'',headers.get('authorization')||''].join('\n')};
}

function responseFromSnapshot(snapshot){
  return new Response(snapshot.body,{
    status:snapshot.status,
    statusText:snapshot.statusText,
    headers:snapshot.headers,
  });
}

async function responseSnapshot(response){
  return {
    body:NULL_BODY_STATUS.has(response.status)?null:await response.clone().text(),
    status:response.status,
    statusText:response.statusText,
    headers:[...response.headers.entries()],
  };
}

export function createShReadFetch(nativeFetch,nowFn=Date.now){
  if(typeof nativeFetch!=='function')throw new TypeError('nativeFetch must be a function');
  const cache=new Map();let minute=null;
  const wrapped=async(input,init={})=>{
    const request=cacheable(input,init,Number(nowFn())||Date.now());
    if(!request)return nativeFetch(input,init);
    if(minute!==request.minute){cache.clear();minute=request.minute;}
    const existing=cache.get(request.key);
    if(existing)return responseFromSnapshot(existing);

    const response=await nativeFetch(input,init);
    if(!response?.ok)return response;
    let snapshot;
    try{snapshot=await responseSnapshot(response);}catch{return response;}
    if(minute!==request.minute)return response;
    while(cache.size>=MAX)cache.delete(cache.keys().next().value);
    cache.set(request.key,snapshot);
    return response;
  };
  Object.defineProperty(wrapped,MARK,{value:true});return wrapped;
}

if(typeof globalThis.fetch==='function'&&!globalThis.fetch[MARK])globalThis.fetch=createShReadFetch(globalThis.fetch.bind(globalThis));
