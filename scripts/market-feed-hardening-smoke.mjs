// Offline execution of both real Edge entrypoints. No live network or database.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {PGlite} from '@electric-sql/pglite';
import { marketSyncForVm, withSharedModules } from './lib/market-sync-vm.mjs';
const read=p=>fs.readFileSync(new URL(`../${p}`,import.meta.url),'utf8');
const worker=read('supabase/functions/market-sync/index.ts');
const queue=read('supabase/functions/market-refresh-queue-cached/index.ts');
const policy=s=>s.slice(s.indexOf('// Queue policy:'),s.indexOf('// End queue policy.'));
assert.equal(policy(worker),policy(queue),'standalone queue policy drift');
assert.doesNotMatch(queue,/import\s|import\(|raw\.githubusercontent|globalThis\.fetch\s*=/);
const uid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
function harness(source,fetchImpl){
  const logs=[],requests=[];let handler;
  const ctx=vm.createContext({URL,URLSearchParams,Response,Request,ReadableStream,TextDecoder,TextEncoder,AbortSignal,setTimeout,clearTimeout,
    console:{log:(...args)=>logs.push(args),error:(...args)=>logs.push(args),warn:(...args)=>logs.push(args)},
    Deno:{env:{get:k=>({SUPABASE_URL:'https://offline.invalid',SUPABASE_SERVICE_ROLE_KEY:'fixture',MARKET_SYNC_SECRET:'fixture',
      CARDMARKET_PRODUCT_CATALOG_URL:'https://downloads.s3.cardmarket.com/products_singles_3.json',CARDMARKET_PRICE_GUIDE_URL:'https://downloads.s3.cardmarket.com/price_guide_3.json'})[k]},serve:fn=>{handler=fn;}},
    fetch:async(url,options)=>{requests.push({url:String(url),options});return fetchImpl(url,options);}});
  vm.runInContext(marketSyncForVm(source),withSharedModules(ctx));
  return {ctx,logs,requests,call:(body={},secret='fixture')=>handler(new Request('https://offline.invalid/worker',{method:'POST',headers:{'x-market-sync-secret':secret},body:JSON.stringify(body)}))};
}
const metrics=h=>h.logs.map(a=>{try{return JSON.parse(a[0]);}catch{return null;}}).filter(Boolean);
for(const source of [queue,worker]){
  for(const count of [0,1,3000]){
    const h=harness(source,async(url,options)=>{
      const u=new URL(url);assert.equal(u.hostname,'offline.invalid');assert.equal(options.method,'POST');
      assert.equal(u.pathname,'/rest/v1/rpc/market_refresh_queue_pending');assert.equal(options.body,'{}');
      return Response.json(count>0);
    });
    const r=await h.call({refreshQueue:true});assert.equal(r.status,200);
    const body=await r.json();assert.equal(body.status,count?'deferred':'skipped');assert.equal(h.requests.length,1);
    assert.ok(metrics(h).some(m=>m.event===(count?'market_queue_deferred_until_daily':'market_queue_empty_skip_feed')&&m.market_sync_feed_bytes===0&&m.market_sync_storage_bytes_read===0));
    assert.ok(Buffer.byteLength(JSON.stringify(body))<150);
    await h.call({priorityQueue:true});assert.equal(h.requests.length,2,'repeat queue uses one small query only');
    const unauthorized=await h.call({},'wrong');assert.equal(unauthorized.status,401);assert.equal(h.requests.length,2);
  }
  const failed=harness(source,async()=>new Response('DB unavailable',{status:503}));
  assert.equal((await failed.call({refreshQueue:true})).status,503);assert.equal(failed.requests.length,1,'no feed fallback after DB failure');
}
const noBulk=harness(worker,()=>{throw new Error('No network allowed');});
for(const body of [{},{pricesOnly:true},{canaryPrintingIds:[uid(1)]},{dryTargetPrintingIds:[uid(1)]}])assert.equal((await noBulk.call(body)).status,409);
assert.equal(noBulk.requests.length,0);
console.log('PASS both HTTP entrypoints: empty/one/3000 targets, retry, auth, failure; 0 heavy bytes');

const priceBody=JSON.stringify({createdAt:'2026-10-04T03:00:00Z',priceGuides:Array.from({length:1000},(_,i)=>({idProduct:i+1,trend:10+i,low:9+i}))});
const target=n=>({mapping_id:uid(n+1000),printing_id:uid(n),provider_product_id:String(n),resolution_status:'manual',variant_key:'default',foil:false,provider_metadata:{active:true},refresh_requested_at:'2026-10-03T12:00:00+00:00'});
for(const count of [1,3,100]){
  const h=harness(worker,async url=>{assert.match(String(url),/price_guide_3.json$/);return new Response(priceBody);});
  const writes=[];h.ctx.targets=Array.from({length:count},(_,i)=>target(i+1));h.ctx.captureWrite=(...args)=>writes.push(args);
  vm.runInContext("rpc=async()=> 'fixture-run';rpcPages=async()=>({rows:targets,requests:1});finish=async()=>{};rest=async(...a)=>captureWrite(...a);",h.ctx);
  const result=await (await h.call({mode:'daily_full'})).json();assert.equal(result.ok,true);
  assert.equal(h.requests.length,1,'daily resolver skips current mappings; price guide once across all targets');
  const inserts=writes.filter(w=>w[0].startsWith('market_price_snapshots?'));
  assert.equal(inserts.flatMap(w=>w[2]).length,count*2);
  for(const w of inserts){assert.equal(w[1],'POST');assert.equal(w[3].Prefer,'resolution=ignore-duplicates,return=minimal');assert.ok(w[2].every(r=>/^.+:\d{4}-\d{2}-\d{2}$/.test(r.observation_key)));}
  const ack=writes.filter(w=>w[1]==='PATCH');assert.equal(ack.length,1);
  const q=new URL(`https://offline.invalid/${ack[0][0]}`).searchParams.get('or');
  for(const t of h.ctx.targets){assert.ok(q.includes(`id.eq.${t.mapping_id}`));assert.ok(q.includes(`refresh_requested_at.eq.${t.refresh_requested_at}`));}
  const complete=metrics(h).filter(m=>m.state==='complete');assert.equal(complete.length,1);assert.equal(complete[0].market_sync_feed_bytes,Buffer.byteLength(priceBody));assert.equal(complete[0].market_sync_storage_bytes_read,0);
}
console.log('PASS daily real parser + writer: 1/3/100 targets, one feed, append-only, conditional queue acknowledgement');

// Exact cron payload: pricesOnly skips catalog even when unresolved targets exist.
{
  const h=harness(worker,async url=>{assert.match(String(url),/price_guide_3.json$/);return new Response(priceBody);});
  h.ctx.targets=[target(1),{...target(2),resolution_status:'unresolved',provider_metadata:{}}];
  vm.runInContext(`rpc=async()=> 'run';rpcPages=async()=>({rows:targets,requests:1});finish=async()=>{};rest=async()=>{};releaseProviderSync=async()=>{};
    isThreeInRome=()=>true;listCardPrintings=async()=>{throw new Error('pricesOnly must not load catalog');};`,h.ctx);
  const body={mode:'daily_full',scheduled:true,pricesOnly:true,recoverStale:true};
  assert.equal((await (await h.call(body)).json()).ok,true);assert.equal(h.requests.length,1);
  vm.runInContext('isThreeInRome=()=>false',h.ctx);
  assert.equal((await (await h.call(body)).json()).reason,'outside_03_europe_rome');assert.equal(h.requests.length,1);
}

// Pending resolver work permits the two catalog feeds once, followed by one
// price feed. Stub only catalog normalization/mapping persistence, not HTTP.
{
  const h=harness(worker,async url=>new Response(String(url).includes('price_guide')?priceBody:'catalog fixture'));
  h.ctx.targets=[{...target(1),resolution_status:'unresolved',provider_metadata:{}}];
  vm.runInContext(`rpc=async()=> 'run';rpcPages=async()=>({rows:targets,requests:1});finish=async()=>{};rest=async()=>{};
    listCardPrintings=async()=>({rows:[],requests:1});withCanonicalCardNames=async()=>[];
    CardmarketPriceGuideProvider.prototype.loadCatalog=async function(){await (await this.request(this.catalogUrl)).text();await (await this.request(this.catalogUrl.replace('products_singles','products_nonsingles'))).text();return {};};
    resolveCardmarketTargets=async()=>{targets[0].resolution_status='manual';return targets;};`,h.ctx);
  const result=await (await h.call({mode:'daily_full'})).json();assert.equal(result.ok,true);
  assert.equal(h.requests.length,3);assert.equal(new Set(h.requests.map(r=>r.url)).size,3);
}

// Failure/unavailable price must preserve the queue. Inserts must finish before acknowledgement.
for(const failInsert of [true,false]){
  const h=harness(worker,()=>{throw new Error('unexpected network');});const writes=[];
  h.ctx.targets=[target(1)];h.ctx.captureWrite=(table,method)=>{writes.push({table,method});if(failInsert&&method==='POST')throw new Error('fixture write failure');};
  vm.runInContext("rpc=async()=> 'run';rpcPages=async()=>({rows:targets,requests:1});finish=async()=>{};rest=captureWrite;recordMappingError=async()=>{};",h.ctx);
  await h.ctx.syncProvider({name:'cardmarket',getPriceMetadata:()=>({status:'available'}),loadPrices:async()=>({}),getCurrentPrice:async()=>failInsert?{status:'available',currency:'EUR',prices:[{type:'trend',value:10}]}:{status:'unavailable'}},{pricesOnly:true});
  assert.equal(writes.filter(w=>w.method==='PATCH').length,0);
}
// Per-provider request guard survives HTTP errors and partial transfer failures.
for(const responseKind of ['ok','503','throw']){
  let calls=0;const h=harness(worker,async()=>{calls++;if(responseKind==='throw')throw new Error('network failure');return new Response('fixture',{status:responseKind==='503'?503:200});});
  vm.runInContext('testProvider=new CardmarketPriceGuideProvider()',h.ctx);
  const url='https://downloads.s3.cardmarket.com/price_guide_3.json';
  if(responseKind==='ok')await (await h.ctx.testProvider.request(url)).text();else await assert.rejects(h.ctx.testProvider.request(url));
  await assert.rejects(h.ctx.testProvider.request(url),/bulk_feed_already_requested/);assert.equal(calls,1);
}
{
  let calls=0;
  const h=harness(worker,async()=>{calls++;return new Response(new ReadableStream({pull(controller){controller.error(new Error('partial body failure'));}}));});
  vm.runInContext('testProvider=new CardmarketPriceGuideProvider()',h.ctx);
  const url='https://downloads.s3.cardmarket.com/price_guide_3.json';
  await assert.rejects((await h.ctx.testProvider.request(url)).text(),/partial body failure/);
  await assert.rejects(h.ctx.testProvider.request(url),/bulk_feed_already_requested/);assert.equal(calls,1);
  assert.ok(metrics(h).some(m=>m.state==='failed'));
}
// A hypothetical storage HIT is measured as paid-risk bytes, never zero.
const hit=harness(worker,()=>{throw new Error('network');});
await hit.ctx.measureMarketFeed(new Response('cached fixture',{headers:{'x-market-cache':'hit'}}),'https://downloads.s3.cardmarket.com/price_guide_3.json','fixture-hit').text();
assert.ok(metrics(hit).some(m=>m.state==='complete'&&m.market_sync_cache_hit===1&&m.market_sync_storage_bytes_read===14));
const miss=harness(worker,()=>{throw new Error('network');});
await miss.ctx.measureMarketFeed(new Response('external fixture',{headers:{'x-market-cache':'miss'}}),'https://downloads.s3.cardmarket.com/price_guide_3.json','fixture-miss').text();
assert.ok(metrics(miss).some(m=>m.state==='complete'&&m.market_sync_cache_miss===1&&m.market_sync_feed_bytes===16&&m.market_sync_storage_bytes_read===0));
console.log('PASS no heavy retry/fallback loop, cache accounting, pending on failure');

const db=new PGlite();
try{
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
    create table card_printings(id uuid primary key,game text);
    create table collection_items(printing_id uuid,owner_slug text default 'fixture',quantity_owned integer default 1);
    create table deck_cards(printing_id uuid,deck_id uuid,quantity integer);
    create table decks(id uuid,owner_slug text);
    create table market_watch_items(printing_id uuid,member_slug text);
    create table market_provider_printings(id uuid,printing_id uuid,provider text,resolution_status text,refresh_requested_at timestamptz);
    create table market_price_snapshots(printing_id uuid,provider text);`);
  const base=read('supabase-milestone-5-market-watch.sql');
  await db.exec(base.slice(base.indexOf('create or replace view public.market_monitored_printings'),base.indexOf('create or replace function public.market_reference_type')));
  await db.exec('alter table collection_items enable row level security;alter table market_provider_printings enable row level security;');
  const sql=read('supabase/manual/market-feed-queue-probe.sql');await db.exec(sql);await db.exec(sql);
  assert.equal((await db.query("select prosecdef from pg_proc where oid='public.market_refresh_queue_pending()'::regprocedure")).rows[0].prosecdef,false);
  const pending=async()=>(await db.query('select public.market_refresh_queue_pending() as pending')).rows[0].pending;
  assert.equal(await pending(),false);
  await db.query("insert into card_printings values($1,'yugioh'),($2,'onepiece')",[uid(1),uid(2)]);
  assert.equal(await pending(),false,'unmonitored printing excluded');
  await db.query('insert into collection_items(printing_id) values($1)',[uid(2)]);assert.equal(await pending(),false,'other game excluded');
  await db.query('insert into collection_items(printing_id) values($1)',[uid(1)]);assert.equal(await pending(),true,'missing mapping');
  await db.query("insert into market_provider_printings values($1,$2,'cardmarket','unresolved',null)",[uid(1001),uid(1)]);
  assert.equal(await pending(),false,'existing unresolved mapping belongs to daily resolver, matching original queue');
  await db.exec("update market_provider_printings set resolution_status='manual'");assert.equal(await pending(),true,'resolved mapping missing its first price');
  await db.query("insert into market_price_snapshots values($1,'other')",[uid(1)]);assert.equal(await pending(),true);
  await db.query("insert into market_price_snapshots values($1,'cardmarket')",[uid(1)]);assert.equal(await pending(),false);
  await db.exec('update market_provider_printings set refresh_requested_at=now()');assert.equal(await pending(),true,'explicit refresh');
  for(const role of ['anon','authenticated','service_role']){
    const permitted=(await db.query("select has_function_privilege($1,'public.market_refresh_queue_pending()','EXECUTE') allowed",[role])).rows[0].allowed;
    assert.equal(permitted,role==='service_role');
  }
  for(const role of ['anon','authenticated']){await db.exec(`set role ${role}`);await assert.rejects(pending(),/permission denied/);await db.exec('reset role');}
  await db.exec('set role service_role');assert.equal(await pending(),true);await db.exec('reset role');
  // Real worker acknowledgement predicate against PostgreSQL state. Simulate a
  // new request arriving after targets were read, before the old run's PATCH.
  await db.query('update market_provider_printings set refresh_requested_at=$1',[target(1).refresh_requested_at]);
  await db.query("insert into market_provider_printings values($1,$2,'cardmarket','manual',$3)",[uid(1002),uid(2),target(2).refresh_requested_at]);
  const concurrent=harness(worker,()=>{throw new Error('unexpected network');});
  concurrent.ctx.targets=[target(1),target(2)];
  concurrent.ctx.captureWrite=async(table,method)=>{
    if(method==='POST')await db.query('update market_provider_printings set refresh_requested_at=$1 where id=$2',['2026-10-04T04:00:00Z',uid(1002)]);
    if(method==='PATCH'){
      const filter=new URL(`https://offline.invalid/${table}`).searchParams.get('or');
      for(const match of filter.matchAll(/and\(id\.eq\.([\da-f-]+),refresh_requested_at\.eq\.([^)]*)\)/g))
        await db.query('update market_provider_printings set refresh_requested_at=null where id=$1 and refresh_requested_at=$2',[match[1],match[2]]);
    }
  };
  vm.runInContext("rpc=async()=> 'run';rpcPages=async()=>({rows:targets,requests:1});finish=async()=>{};rest=captureWrite;",concurrent.ctx);
  await concurrent.ctx.syncProvider({name:'cardmarket',getPriceMetadata:()=>({status:'available'}),loadPrices:async()=>({}),getCurrentPrice:async()=>({status:'available',currency:'EUR',prices:[{type:'trend',value:10}]})},{pricesOnly:true});
  const timestamps=(await db.query("select id,(refresh_requested_at at time zone 'UTC')::text stamp from market_provider_printings order by id")).rows;
  assert.equal(timestamps[0].stamp,null);assert.match(timestamps[1].stamp,/2026-10-04 04:00:00/);
  console.log('PASS concurrent acknowledgement: old request cleared, newer request preserved in PostgreSQL');
  console.log('PASS real PostgreSQL: minimal EXISTS probe, queue semantics, idempotent SQL, anon/auth denied, service_role allowed');
}finally{await db.close();}
