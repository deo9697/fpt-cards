import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const nativeFetch = globalThis.fetch.bind(globalThis);
const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const bucket = 'market-feed-cache';

function isCardmarketBulk(value: string) {
  try {
    const u = new URL(value);
    const official = u.protocol === 'https:' && (u.hostname === 'cardmarket.com' || u.hostname === 'www.cardmarket.com' || u.hostname.endsWith('.cardmarket.com') || u.hostname === 'downloads.s3.cardmarket.com');
    return official && /\/(?:products_singles|products_nonsingles|price_guide)_\d+\.json$/i.test(u.pathname);
  } catch { return false; }
}

function marketCacheDay(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone:'Europe/Rome', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', hourCycle:'h23' }).formatToParts(now);
  const values = Object.fromEntries(parts.map(p => [p.type,p.value]));
  let y=Number(values.year),m=Number(values.month),d=Number(values.day);
  if(Number(values.hour)<3){const prev=new Date(Date.UTC(y,m-1,d)-86400000);y=prev.getUTCFullYear();m=prev.getUTCMonth()+1;d=prev.getUTCDate();}
  return `${String(y).padStart(4,'0')}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}

function cachePath(value:string){const u=new URL(value),name=u.pathname.split('/').filter(Boolean).pop()||'feed.json';return `${marketCacheDay()}/${name}`;}
function encodedPath(path:string){return path.split('/').map(encodeURIComponent).join('/');}
function storageHeaders(){return {apikey:serviceKey,Authorization:`Bearer ${serviceKey}`};}

async function cacheUpload(path:string,body:ReadableStream<Uint8Array>,contentType:string){
  try{
    const response=await nativeFetch(`${supabaseUrl}/storage/v1/object/${bucket}/${encodedPath(path)}`,{method:'POST',headers:{...storageHeaders(),'content-type':contentType||'application/json','cache-control':'86400','x-upsert':'false'},body});
    if(!response.ok&&response.status!==400&&response.status!==409)console.error('[market-cache] upload failed',{path,status:response.status,detail:(await response.text()).slice(0,200)});
    else console.log('[market-cache] stored',{path,status:response.status});
  }catch(error){console.error('[market-cache] upload error',{path,error:String((error as any)?.message||error)});}
}

async function cachedFetch(input:RequestInfo|URL,init?:RequestInit):Promise<Response>{
  const url=typeof input==='string'?input:input instanceof URL?input.toString():input.url;
  const method=String(init?.method||(input instanceof Request?input.method:'GET')).toUpperCase();
  if(method!=='GET'||!isCardmarketBulk(url)||!supabaseUrl||!serviceKey)return nativeFetch(input as any,init);
  const path=cachePath(url),objectUrl=`${supabaseUrl}/storage/v1/object/authenticated/${bucket}/${encodedPath(path)}`;
  try{
    const cached=await nativeFetch(objectUrl,{headers:storageHeaders()});
    if(cached.ok){console.log('[market-cache] hit',{path});return cached;}
    try{await cached.body?.cancel();}catch{}
  }catch(error){console.warn('[market-cache] read failed, falling back',{path,error:String((error as any)?.message||error)});}
  const external=await nativeFetch(input as any,init);
  if(!external.ok||!external.body)return external;
  const [forCaller,forCache]=external.body.tee();
  const upload=cacheUpload(path,forCache,external.headers.get('content-type')||'application/json');
  try{EdgeRuntime.waitUntil(upload);}catch{void upload;}
  console.log('[market-cache] miss',{path});
  return new Response(forCaller,{status:external.status,statusText:external.statusText,headers:external.headers});
}

globalThis.fetch=cachedFetch as typeof globalThis.fetch;
await import('https://raw.githubusercontent.com/deo9697/fpt-cards/b7a484c5ef92cd0bd834f1e7f59d233189a7bfd1/supabase/functions/market-sync/index.ts');
