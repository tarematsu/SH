const ORIGIN='https://production1.stationhead.com';
const PREFIX=`${ORIGIN}/station/`;
const MAX=32;
const MARK=Symbol.for('sh-monitor.sh-read-cache');

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

export function createSHReadFetch(nativeFetch,nowFn=Date.now){
  if(typeof nativeFetch!=='function')throw new TypeError('nativeFetch must be a function');
  const cache=new Map();let minute=null;
  const wrapped=async(input,init={})=>{
    const request=cacheable(input,init,Number(nowFn())||Date.now());
    if(!request)return nativeFetch(input,init);
    if(minute!==request.minute){cache.clear();minute=request.minute;}
    const existing=cache.get(request.key);if(existing)return (await existing).clone();
    while(cache.size>=MAX)cache.delete(cache.keys().next().value);
    const pending=Promise.resolve().then(()=>nativeFetch(input,init)).then((response)=>{if(!response?.ok)cache.delete(request.key);return response;}).catch((error)=>{cache.delete(request.key);throw error;});
    cache.set(request.key,pending);return (await pending).clone();
  };
  Object.defineProperty(wrapped,MARK,{value:true});return wrapped;
}

if(typeof globalThis.fetch==='function'&&!globalThis.fetch[MARK])globalThis.fetch=createSHReadFetch(globalThis.fetch.bind(globalThis));
