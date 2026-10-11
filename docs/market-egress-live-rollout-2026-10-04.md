# FPT Cards — exact live rollout package, 2026-10-04

PREPARED ONLY. No live calls, deploy, secrets changes, cron changes, commit or push.
The complete deployable market-sync source is included in the accompanying bundle; do not reconstruct it from a partial patch.

## A. QUEUE WRAPPER FULL CONTENT

FILE: `supabase/functions/market-refresh-queue-cached/index.ts`

```ts
// Local replacement for the remote-pinned Storage wrapper. No runtime imports.
// Deploy only with the coordinated package in docs/market-egress-live-rollout-2026-10-04.md.
const supabaseUrl=Deno.env.get('SUPABASE_URL')||'';
const serviceKey=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||'';
const syncSecret=Deno.env.get('MARKET_SYNC_SECRET')||'';
Deno.serve(async request=>{
  if(request.method!=='POST')return json({error:'method_not_allowed'},405);
  if(!supabaseUrl||!serviceKey||!syncSecret)return json({error:'backend_not_configured'},503);
  if(request.headers.get('x-market-sync-secret')!==syncSecret)return json({error:'unauthorized'},401);
  // This endpoint is ALWAYS cheap, including legacy cron bodies and malformed bodies.
  return deferMarketQueue();
});
// Queue policy: one bounded DB response, no feed, no writes. Kept identical in both entrypoints.
async function deferMarketQueue(){
  const metrics={market_sync_mode:'queue_targeted',market_sync_feed_bytes:0,market_sync_storage_bytes_read:0,market_sync_cache_hit:0,market_sync_cache_miss:0,market_sync_feed_skipped:true,market_sync_targets:0,targets_are_lower_bound:true};
  try{
    const response=await fetch(`${supabaseUrl}/rest/v1/rpc/market_refresh_queue_pending`,{method:'POST',headers:headers(),body:'{}',signal:AbortSignal.timeout(15000)});
    if(!response.ok){await response.body?.cancel();throw new Error('queue_precheck_failed');}
    const pending=await response.json();
    if(typeof pending!=='boolean')throw new Error('invalid_queue_precheck');
    metrics.market_sync_targets=pending?1:0;
    const event=pending?'market_queue_deferred_until_daily':'market_queue_empty_skip_feed';
    console.log(JSON.stringify({event,...metrics}));
    return json({ok:true,status:pending?'deferred':'skipped',reason:pending?'awaiting_daily_full':'queue_empty',mode:'queue_targeted'});
  }catch{
    console.error(JSON.stringify({event:'market_queue_precheck_failed',...metrics,market_sync_targets:null}));
    return json({ok:false,error:'queue_precheck_failed'},503);
  }
}
// End queue policy.
function headers(){return {'content-type':'application/json',apikey:serviceKey,Authorization:`Bearer ${serviceKey}`};}
function json(body:unknown,status=200){return new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json','cache-control':'no-store'}});}
```
## B. CANONICAL PRIVATE RPC FULL CONTENT

FILE: `supabase/manual/market-feed-queue-probe.sql`

```sql
-- PREPARED ONLY. Apply before deploying either hardened Edge entrypoint.
-- Mirrors the existing market_sync_targets('cardmarket') queue predicate,
-- without projecting candidate metadata, names, languages or catalog rows.
begin;
create or replace function public.market_refresh_queue_pending()
returns boolean language sql stable security invoker
set search_path = ''
set statement_timeout = '10s'
as $$
  select exists (
    select 1
    from public.market_monitored_printings m
    join public.card_printings cp on cp.id=m.printing_id and cp.game='yugioh'
    left join public.market_provider_printings mp
      on mp.printing_id=cp.id and mp.provider='cardmarket'
    where mp.id is null
       or mp.refresh_requested_at is not null
       or (mp.resolution_status in ('resolved','manual') and not exists (
         select 1 from public.market_price_snapshots s
         where s.provider='cardmarket' and s.printing_id=cp.id
       ))
  );
$$;
revoke all on function public.market_refresh_queue_pending() from public,anon,authenticated;
grant execute on function public.market_refresh_queue_pending() to service_role;
grant select on public.market_monitored_printings, public.card_printings,
  public.market_provider_printings, public.market_price_snapshots,
  public.collection_items, public.deck_cards, public.decks,
  public.market_watch_items to service_role;
notify pgrst, 'reload schema';
commit;
```
## C. CRON ROLLOUT FULL CONTENT

FILE: `supabase/manual/market-egress-cron-rollout.sql`

```sql
-- PREPARED ONLY. Run phases separately; this file NEVER reactivates jobs by default.
-- PAUSE (committed even if a later precondition fails).
begin;
do $guard$
begin
  if (select count(*) from cron.job
      where (jobid=5 and jobname='fpt-market-refresh-queue')
         or (jobid=6 and jobname='fpt-market-sync-daily')) <> 2 then
    raise exception 'Unexpected cron IDs/names; stop without creating jobs';
  end if;
end;
$guard$;
select cron.alter_job(job_id:=5, active:=false);
select cron.alter_job(job_id:=6, active:=false);
commit;

-- ALTER COMMAND while paused, after deploying both functions and the private RPC.
begin;
do $guard$
begin
  if exists(select 1 from public.market_provider_sync_runs where status='running') then
    raise exception 'Active sync runs must be zero';
  end if;
  if coalesce(current_setting('cron.timezone',true),'GMT') not in ('GMT','UTC','Etc/UTC') then
    raise exception 'Expected UTC cron timezone';
  end if;
  if (select count(*) from vault.decrypted_secrets
      where name='market_sync_secret' and nullif(decrypted_secret,'') is not null) <> 1 then
    raise exception 'Expected exactly one nonempty market_sync_secret in Vault';
  end if;
  if to_regprocedure('public.market_refresh_queue_pending()') is null then
    raise exception 'Install private queue RPC first';
  end if;
end;
$guard$;
select cron.alter_job(job_id:=5, schedule:='5,20,35,50 * * * *',
  command:=$queue$
  select net.http_post(
    url := 'https://gonycawupahawocqafcf.supabase.co/functions/v1/market-refresh-queue-cached',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'x-market-sync-secret',
      (select decrypted_secret from vault.decrypted_secrets where name='market_sync_secret')
    ),
    body := '{"refreshQueue":true}'::jsonb,
    timeout_milliseconds := 30000
  );
  $queue$, active:=false);
select cron.alter_job(job_id:=6, schedule:='0 1,2 * * *',
  command:=$daily$
  select net.http_post(
    url := 'https://gonycawupahawocqafcf.supabase.co/functions/v1/market-sync',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'x-market-sync-secret',
      (select decrypted_secret from vault.decrypted_secrets where name='market_sync_secret')
    ),
    body := '{"mode":"daily_full","scheduled":true,"pricesOnly":true,"recoverStale":true}'::jsonb,
    timeout_milliseconds := 120000
  )
  where extract(hour from (now() at time zone 'Europe/Rome')) = 3;
  $daily$, active:=false);
commit;
-- Verification: both rows MUST remain inactive here. Command contains a Vault reference, not its value.
select jobid,jobname,schedule,active,command from cron.job where jobid in (5,6) order by jobid;

-- REACTIVATE: separate manual action ONLY AFTER the queue canary passes.
-- Copy/run these statements separately, in this order; do not uncomment before the canary.
-- select cron.alter_job(job_id:=5, active:=true);
-- select cron.alter_job(job_id:=6, active:=true);
-- select jobid,jobname,schedule,active from cron.job where jobid in (5,6) order by jobid;
```
## D. CRON ROLLBACK FULL CONTENT

FILE: `supabase/manual/market-egress-rollout-rollback.sql`

```sql
-- PREPARED ONLY. SAFE-STOP: run only this first block to pause both jobs.
begin;
do $guard$
begin
  if (select count(*) from cron.job
      where (jobid=5 and jobname='fpt-market-refresh-queue')
         or (jobid=6 and jobname='fpt-market-sync-daily')) <> 2 then
    raise exception 'Unexpected cron IDs/names; stop without creating jobs';
  end if;
end;
$guard$;
select cron.alter_job(job_id:=5, active:=false);
select cron.alter_job(job_id:=6, active:=false);
commit;

-- ROLLBACK CRON: restore supplied prior URL/body/guard/schedules, KEEP PAUSED.
-- Timeout 120 seconds follows the repository's original queue schedule.
-- Commands reproduce the supplied prior semantics, not original whitespace.
-- Does NOT roll back Edge code. Old wrapper source is in docs/audit-snapshots/
-- market-egress-2026-10-04/market-refresh-queue-cached-v2.ts.
begin;
select cron.alter_job(job_id:=5, schedule:='5,20,35,50 * * * *',
  command:=$queue$
  select net.http_post(
    url := 'https://gonycawupahawocqafcf.supabase.co/functions/v1/market-refresh-queue-cached',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'x-market-sync-secret',
      (select decrypted_secret from vault.decrypted_secrets where name='market_sync_secret')
    ),
    body := '{"refreshQueue":true}'::jsonb,
    timeout_milliseconds := 120000
  );
  $queue$, active:=false);
select cron.alter_job(job_id:=6, schedule:='0 1,2 * * *',
  command:=$daily$
  select net.http_post(
    url := 'https://gonycawupahawocqafcf.supabase.co/functions/v1/market-refresh-queue-cached',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'x-market-sync-secret',
      (select decrypted_secret from vault.decrypted_secrets where name='market_sync_secret')
    ),
    body := jsonb_build_object('pricesOnly',true,'recoverStale',true,'source','daily_price_refresh'),
    timeout_milliseconds := 120000
  )
  where extract(hour from (now() at time zone 'Europe/Rome')) = 3;
  $daily$, active:=false);
commit;
select jobid,jobname,schedule,active,command from cron.job where jobid in (5,6) order by jobid;
-- No automatic reactivation: the old wrapper has the known egress regression.
-- Restored daily command requires the old wrapper code; the new wrapper defers it.
-- Prefer SAFE-STOP until a corrected direct daily is available.
```
## E. DIFF — market-sync P0 only

Relative to local Git HEAD, not a fetched live v57 source. Deploy the complete source supplied in this bundle.

```diff
diff --git a/supabase/functions/market-sync/index.ts b/supabase/functions/market-sync/index.ts
index 9a0ebe3..ff37eba 100644
--- a/supabase/functions/market-sync/index.ts
+++ b/supabase/functions/market-sync/index.ts
@@ -47,7 +47,27 @@ class PriceProvider {
   getPriceMetadata(...args:any[]):any{throw new Error('getPriceMetadata() non implementato');}
 }

+// Counts decoded bytes actually consumed, not a Content-Length estimate or a
+// billing counter. Each log is cumulative per egress_id + feed; use the last/max.
+function measureMarketFeed(response:Response,url:string,egressId:string){
+  const reader=response.body?.getReader();if(!reader)return response;
+  const cache=response.headers.get('x-market-cache')||(response.url.includes('/storage/v1/')?'hit':'bypass');
+  const storage=cache==='hit'||response.url.includes('/storage/v1/');
+  let bytes=0,lastLogged=0;
+  const emit=(state:string)=>console.log(JSON.stringify({event:'market_sync_feed_bytes',egress_id:egressId,feed:new URL(url).pathname.split('/').pop(),state,
+    market_sync_mode:'daily_full',market_sync_feed_bytes:bytes,market_sync_storage_bytes_read:storage?bytes:0,
+    market_sync_cache_hit:cache==='hit'?1:0,market_sync_cache_miss:cache==='miss'?1:0,market_sync_feed_skipped:false,cache_source:cache}));
+  emit('started');
+  const body=new ReadableStream({
+    async pull(controller){try{const {done,value}=await reader.read();if(done){emit('complete');controller.close();return;}bytes+=value.byteLength;controller.enqueue(value);if(bytes-lastLogged>=1048576){lastLogged=bytes;emit('progress');}}catch(error){emit('failed');controller.error(error);}},
+    async cancel(reason){emit('cancelled');await reader.cancel(reason);}
+  });
+  return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
+}
+
 class CardmarketPriceGuideProvider extends PriceProvider {
+  feedRequests=new Set<string>();
+  egressId=`${Date.now()}-${Math.random().toString(36).slice(2)}`;
   catalogUrl:string;priceGuideUrl:string;sleep:any;timeoutMs:number;catalog:any[];expansionHints:Map<string,any>;prices:Map<string,any>;sourceUpdatedAt:string;loaded:boolean;
   constructor({catalogUrl='',priceGuideUrl='',fetchImpl=globalThis.fetch,sleep=delay,timeoutMs=180000}:any={}){
     super({name:'cardmarket',fetchImpl});this.catalogUrl=catalogUrl;this.priceGuideUrl=priceGuideUrl;this.sleep=sleep;this.timeoutMs=timeoutMs;this.catalog=[];this.expansionHints=new Map();this.prices=new Map();this.sourceUpdatedAt='';this.loaded=false;
@@ -57,10 +77,15 @@ class CardmarketPriceGuideProvider extends PriceProvider {
     priceTypes:['low','trend','average','avg1','avg7','avg30','foil_low','foil_trend','foil_average','foil_avg1','foil_avg7','foil_avg30'],
     languageScope:'aggregate',editionScope:'aggregate',rarityScope:'product_variant_unlabeled',foilScope:'parallel_columns_unassigned',resolverVersion:CARDMARKET_RESOLVER_VERSION};}
   async request(url:string,{maxAttempts=3}:any={}):Promise<any>{
+    // Bulk transfers are single-attempt per invocation, even after a partial failure.
+    // Recovery is a new explicit job, never an automatic 17 MB retry loop.
+    const bulk=url===this.catalogUrl||url===this.priceGuideUrl||/\/(?:products_singles|products_nonsingles|price_guide)_\d+\.json(?:\?|$)/i.test(url);
+    if(bulk){if(this.feedRequests.has(url))throw new Error('bulk_feed_already_requested');this.feedRequests.add(url);maxAttempts=1;}
     for(let attempt=0;attempt<maxAttempts;attempt++){
       let response:any;
       try{response=await this.fetch(url,{signal:typeof AbortSignal!=='undefined'&&typeof AbortSignal.timeout==='function'?AbortSignal.timeout(this.timeoutMs):undefined});}
       catch(error){if(attempt===maxAttempts-1)throw error;await this.sleep(backoff(attempt));continue;}
+      if(bulk)response=measureMarketFeed(response,url,this.egressId);
       if(response.ok)return response;
       if(![429,500,502,503,504].includes(response.status)||attempt===maxAttempts-1)throw new ProviderHttpError(this.name,response.status,await safeText(response));
       const retryAfter=Number(response.headers?.get?.('retry-after'));await this.sleep(Number.isFinite(retryAfter)&&retryAfter>0?retryAfter*1000:backoff(attempt));
@@ -122,7 +147,7 @@ class CardmarketPriceGuideProvider extends PriceProvider {
     validateOfficialCardmarketUrl(this.priceGuideUrl);
     const wantedProductIds=new Set((targets||[]).filter((row:any)=>isAuthorizedCardmarketMapping(row)).flatMap(mappingProductIds));
     this.prices=new Map();
-    if(!wantedProductIds.size){this.sourceUpdatedAt=new Date().toISOString();this.loaded=true;return {priceRows:0,retainedPriceRows:0,mode:'prices_only'};}
+    if(!wantedProductIds.size){console.log(JSON.stringify({event:'market_sync_feed_skipped',egress_id:this.egressId,market_sync_mode:'daily_full',market_sync_feed_bytes:0,market_sync_storage_bytes_read:0,market_sync_cache_hit:0,market_sync_cache_miss:0,market_sync_targets:0,market_sync_feed_skipped:true}));this.sourceUpdatedAt=new Date().toISOString();this.loaded=true;return {priceRows:0,retainedPriceRows:0,mode:'prices_only'};}
     const priceResponse=await this.request(this.priceGuideUrl);
     if(!priceResponse.ok)throw new ProviderHttpError(this.name,priceResponse.status,'Price Guide non disponibile');
     const pricePayload=await streamCardmarketRows(priceResponse,'priceGuides',(row:any)=>{const id=productId(row);if(id&&wantedProductIds.has(id))this.prices.set(id,row);});
@@ -530,12 +555,36 @@ const syncSecret=Deno.env.get('MARKET_SYNC_SECRET')||'';
 // mano che raccolta/team crescono.
 const RESOLVER_SAFETY_CEILING=50000;

+// Queue policy: one bounded DB response, no feed, no writes. Kept identical in both entrypoints.
+async function deferMarketQueue(){
+  const metrics={market_sync_mode:'queue_targeted',market_sync_feed_bytes:0,market_sync_storage_bytes_read:0,market_sync_cache_hit:0,market_sync_cache_miss:0,market_sync_feed_skipped:true,market_sync_targets:0,targets_are_lower_bound:true};
+  try{
+    const response=await fetch(`${supabaseUrl}/rest/v1/rpc/market_refresh_queue_pending`,{method:'POST',headers:headers(),body:'{}',signal:AbortSignal.timeout(15000)});
+    if(!response.ok){await response.body?.cancel();throw new Error('queue_precheck_failed');}
+    const pending=await response.json();
+    if(typeof pending!=='boolean')throw new Error('invalid_queue_precheck');
+    metrics.market_sync_targets=pending?1:0;
+    const event=pending?'market_queue_deferred_until_daily':'market_queue_empty_skip_feed';
+    console.log(JSON.stringify({event,...metrics}));
+    return json({ok:true,status:pending?'deferred':'skipped',reason:pending?'awaiting_daily_full':'queue_empty',mode:'queue_targeted'});
+  }catch{
+    console.error(JSON.stringify({event:'market_queue_precheck_failed',...metrics,market_sync_targets:null}));
+    return json({ok:false,error:'queue_precheck_failed'},503);
+  }
+}
+// End queue policy.
+
 Deno.serve(async request=>{
   if(request.method!=='POST')return json({error:'method_not_allowed'},405);
   if(!supabaseUrl||!serviceKey)return json({error:'backend_not_configured'},503);
   if(!syncSecret)return json({error:'sync_secret_not_configured'},503);
   if(request.headers.get('x-market-sync-secret')!==syncSecret)return json({error:'unauthorized'},401);
   const payload=await request.json().catch(()=>({}));
+  // No targeted/queue request may implicitly download the full market universe.
+  if(payload?.priorityQueue===true||payload?.refreshQueue===true)return deferMarketQueue();
+  const adminBulk=payload?.marketVariantCanaryRunId||payload?.marketVariantPriceShadowRunId||payload?.resolvePending===true||payload?.dryTargetPrintingIds||payload?.canaryPrintingIds;
+  if((payload?.dryTargetPrintingIds||payload?.canaryPrintingIds)&&payload?.allowFullFeed!==true)return json({ok:false,error:'explicit_full_feed_required'},409);
+  if(!adminBulk&&!payload?.marketVariantCandidateMetadataRunId&&payload?.scheduled!==true&&payload?.mode!=='daily_full'&&payload?.allowFullFeed!==true)return json({ok:false,error:'explicit_full_feed_required'},409);
   // Canary admin-only del Market Variant Registry — invocato SOLO da
   // run_ygo_market_variant_canary (RPC FPT via net.http_post, mai dal
   // browser direttamente: l'header x-market-sync-secret sopra resta
@@ -574,37 +623,22 @@ Deno.serve(async request=>{
   ];
   const resolverBatchSize=payload?.resolvePending===true?Math.max(1,Math.min(RESOLVER_SAFETY_CEILING,Number(payload?.resolverBatchSize)||100)):0;
   if(resolverBatchSize){const cardmarket=providers.find(provider=>provider.name==='cardmarket');const result=await syncProvider(cardmarket,{recoverStale:payload?.recoverStale===true,pendingResolverLimit:resolverBatchSize,skipPrices:true});return json({ok:['succeeded','partial','skipped'].includes(result.status),mode:'resolver_batch',results:[result]});}
-  // Coda di refresh prioritario (ogni ~15 min, job separato da quello
-  // notturno): scarica il price guide feed UNA volta per ciclo e aggiorna
-  // solo le mappature manuali confermate di recente (refresh_requested_at
-  // valorizzato da set_market_mapping_manual). Sempre pricesOnly: sono già
-  // 'manual' con provider_product_id noto, non serve ririsolvere/scaricare
-  // il catalogo prodotti. Vedi supabase-market-watch-priority-refresh.sql.
-  if(payload?.priorityQueue===true){const cardmarket=providers.find(provider=>provider.name==='cardmarket');const result=await syncProvider(cardmarket,{priorityOnly:true,pricesOnly:true});return json({ok:['succeeded','partial','skipped'].includes(result.status),mode:'priority_queue',results:[result]});}
-  if(payload?.refreshQueue===true){
-    const cardmarket=providers.find(provider=>provider.name==='cardmarket');
-    // One provider cycle per invocation keeps feed parsing within the CPU budget.
-    const result=await syncProvider(cardmarket,{newPrintingsOnly:true});
-    return json({ok:['succeeded','partial','skipped'].includes(result.status),mode:'refresh_queue',results:[result]});
-  }
-  const scheduled=payload?.scheduled===true,pricesOnly=payload?.pricesOnly===true||scheduled;
+  const scheduled=payload?.scheduled===true||payload?.mode==='daily_full',pricesOnly=payload?.pricesOnly===true||scheduled;
   if(canaryPrintingIds.length&&pricesOnly)return json({error:'canary_requires_full_mode'},400);
   if(dryTargetPrintingIds.length){
     const cardmarket=providers.find(provider=>provider.name==='cardmarket');
     return json(await dryTargetCardmarket(cardmarket,dryTargetPrintingIds));
   }
   const results=[];
-  if(scheduled){const cardmarket=providers.find(provider=>provider.name==='cardmarket');results.push(await syncProvider(cardmarket,{pendingResolverLimit:RESOLVER_SAFETY_CEILING,skipPrices:true}));}
+  if(scheduled&&payload?.pricesOnly!==true){const cardmarket=providers.find(provider=>provider.name==='cardmarket');results.push(await syncProvider(cardmarket,{pendingResolverLimit:RESOLVER_SAFETY_CEILING,skipPrices:true}));}
   for(const provider of providers)results.push(await syncProvider(provider,{recoverStale:payload?.recoverStale===true,pricesOnly,targetPrintingIds:canaryPrintingIds}));
   return json({ok:results.some(row=>['succeeded','partial'].includes(row.status)),mode:canaryPrintingIds.length?'canary':scheduled?'scheduled':pricesOnly?'prices_only':'full',results});
 });

-// request()'s per-attempt AbortSignal.timeout(180000) only bounds a single
-// HTTP attempt; with maxAttempts=3 retries plus backoff, one loadCatalog()/
-// loadPrices() call can legitimately run ~15-20 minutes if Cardmarket's feed
-// is slow that day — long past any Edge Function platform time limit. When
-// that happens the platform kills the isolate outright, skipping our own
-// catch block entirely: the sync_runs row is left at status='running' with
+// Bulk request() now permits one attempt only. The historical three-attempt
+// policy could run beyond the platform ceiling. Keep the existing stage
+// deadlines as well: if a feed is slow and the platform kills the isolate,
+// our catch block cannot run: the sync_runs row is left at status='running' with
 // no error, and (since the scheduled sync only runs once a day) it silently
 // blocks all price updates until the next day's attempt notices the >2h-old
 // stale lock. Observed twice in a row (2026-09-05 and 2026-09-06). Racing
@@ -628,7 +662,9 @@ async function syncProvider(provider:any,{recoverStale=false,pricesOnly=false,ta
   if(!runId)return {provider:provider.name,status:'skipped',reason:'sync_already_running'};
   let requestCount=0,snapshots=0,failures=0,feedStats:any=null,targetPages=0,printingPages=0,printingRows=0;
   try{
-    const targetResult=await rpcPages('market_sync_targets',{p_provider:provider.name},{order:'printing_id.asc,variant_key.asc.nullslast,mapping_id.asc.nullslast',key:(row:any)=>row.mapping_id||`${row.printing_id}:${row.variant_key||'default'}`});
+    // Filter the quarter-hour queue before downloading/paginating the RPC result.
+    // An empty queue must not transfer the full multi-megabyte target catalog.
+    const targetResult=await rpcPages('market_sync_targets',{p_provider:provider.name},{filters:priorityOnly?{refresh_requested_at:'not.is.null'}:{},order:'printing_id.asc,variant_key.asc.nullslast,mapping_id.asc.nullslast',key:(row:any)=>row.mapping_id||`${row.printing_id}:${row.variant_key||'default'}`});
     const allTargets=targetResult.rows;targetPages=targetResult.requests;
     const selectedIds=new Set(targetPrintingIds),targets=selectedIds.size?allTargets.filter((target:any)=>selectedIds.has(String(target.printing_id))):newPrintingsOnly?allTargets.filter((target:any)=>!target.mapping_id||target.refresh_requested_at).slice(0,100):priorityOnly?allTargets.filter((target:any)=>target.refresh_requested_at):pendingResolverLimit?allTargets.filter(cardmarketMappingNeedsResolver).slice(0,pendingResolverLimit):allTargets;
     if(newPrintingsOnly&&targets.length&&targets.every((target:any)=>isAuthorizedCardmarketMapping(target)))pricesOnly=true;
@@ -636,6 +672,7 @@ async function syncProvider(provider:any,{recoverStale=false,pricesOnly=false,ta
     const unique=new Map<string,any>();
     for(const target of targets){const key=`${target.printing_id}:${target.variant_key||'default'}`;if(!unique.has(key))unique.set(key,target);}
     let resolvedTargets=[...unique.values()];
+    console.log(JSON.stringify({event:'market_sync_targets',market_sync_mode:'daily_full',market_sync_targets:unique.size,egress_id:provider.egressId||null}));
     if(provider.name==='cardmarket'){
       if(pricesOnly){feedStats=await withDeadline(provider.loadPrices(resolvedTargets),PRICES_DEADLINE_MS,'loadPrices');requestCount+=1;}
       else{
@@ -670,13 +707,14 @@ async function syncProvider(provider:any,{recoverStale=false,pricesOnly=false,ta
       }catch(error:any){failures++;await recordMappingError(target.mapping_id,error);}
     }
     for(let index=0;index<pendingSnapshots.length;index+=250)await rest('market_price_snapshots?on_conflict=provider,observation_key,price_type','POST',pendingSnapshots.slice(index,index+250),{'Prefer':'resolution=ignore-duplicates,return=minimal'});
-    // Un target di priorityOnly è stato "servito" (prezzo trovato o fallito
-    // per un motivo reale, non per errori sistemici a monte che avrebbero
-    // già lanciato prima di qui) — si toglie dalla coda a prescindere
-    // dall'esito per non ritentarlo ogni ~15 min all'infinito.
-    if((priorityOnly||newPrintingsOnly)&&resolvedTargets.length){
-      const ids=resolvedTargets.filter((target:any)=>priorityOnly||target.refresh_requested_at).map((target:any)=>target.mapping_id).filter(Boolean);
-      if(ids.length)await rest(`market_provider_printings?id=in.(${ids.map(encodeURIComponent).join(',')})`,'PATCH',{refresh_requested_at:null},{'Prefer':'return=minimal'});
+    // Acknowledge only successfully persisted observations. Compare the captured
+    // queue timestamp so a newer request is never cleared by this run.
+    const writtenMappings=new Set(pendingSnapshots.map((row:any)=>row.provider_mapping_id));
+    const acknowledged=resolvedTargets.filter((target:any)=>writtenMappings.has(target.mapping_id)&&target.refresh_requested_at);
+    for(let index=0;index<acknowledged.length;index+=100){
+      const conditions=acknowledged.slice(index,index+100).map((target:any)=>`and(id.eq.${target.mapping_id},refresh_requested_at.eq.${target.refresh_requested_at})`);
+      const query=new URLSearchParams({or:`(${conditions.join(',')})`});
+      await rest(`market_provider_printings?${query}`,'PATCH',{refresh_requested_at:null},{'Prefer':'return=minimal'});
     }
     const mappingStates=resolvedTargets.reduce((counts:any,target:any)=>{const key=target.provider_metadata?.resolverStatus||target.resolution_status||'unresolved';counts[key]=(counts[key]||0)+1;return counts;},{});
     const status=failures&&snapshots?'partial':failures&&!snapshots?'failed':'succeeded';
@@ -1070,7 +1108,7 @@ function pricesForTarget(prices:any[],target:any){const foil=target.foil===true;
 function printingIds(value:any){if(!Array.isArray(value)||value.length>20)return[];const ids=[...new Set(value.map(String))];return ids.length&&ids.every(id=>/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))?ids:[];}

 async function rpc(name:string,body:Record<string,unknown>){const response=await fetch(`${supabaseUrl}/rest/v1/rpc/${name}`,{method:'POST',headers:headers(),body:JSON.stringify(body)});if(!response.ok)throw new Error(`${name}: ${response.status} ${await response.text()}`);const text=await response.text();return text?JSON.parse(text):null;}
-async function rpcPages(name:string,body:Record<string,unknown>,options:any={}){return fetchPages(`${supabaseUrl}/rest/v1/rpc/${name}${options.order?`?order=${encodeURIComponent(options.order)}`:''}`,{method:'POST',body:JSON.stringify(body),key:options.key,resource:name,queryPagination:true});}
+async function rpcPages(name:string,body:Record<string,unknown>,options:any={}){const query=new URLSearchParams(options.filters||{});if(options.order)query.set('order',options.order);const suffix=query.toString();return fetchPages(`${supabaseUrl}/rest/v1/rpc/${name}${suffix?`?${suffix}`:''}`,{method:'POST',body:JSON.stringify(body),key:options.key,resource:name,queryPagination:true});}
 async function rest(table:string,method:string,body:unknown,extra:Record<string,string>={}){const response=await fetch(`${supabaseUrl}/rest/v1/${table}`,{method,headers:{...headers(),...extra},body:body==null?undefined:JSON.stringify(body)});if(!response.ok)throw new Error(`${table}: ${response.status} ${await response.text()}`);return response;}
 async function restPages(path:string,options:any={}){return fetchPages(`${supabaseUrl}/rest/v1/${path}`,{method:'GET',key:options.key,resource:path});}
 async function fetchPages(url:string,{method='GET',body,key=(row:any)=>row.id,resource='resource',pageSize=500,maxRows=20000,queryPagination=false}:any={}){const rows:any[]=[],seen=new Set<string>();let requests=0;for(let from=0;from<=maxRows;from+=pageSize){const to=from+pageSize-1,pageUrl=queryPagination?`${url}${url.includes('?')?'&':'?'}limit=${pageSize}&offset=${from}`:url,response=await fetch(pageUrl,{method,headers:{...headers(),Range:`${from}-${to}`,'Range-Unit':'items'},body});if(response.status===416)return {rows,requests};if(!response.ok)throw new Error(`${resource} pagina ${requests+1}: ${response.status} ${await response.text()}`);const page=await response.json();if(!Array.isArray(page))throw new Error(`${resource}: risposta paginata non valida`);requests++;if(from===maxRows&&page.length)throw new Error(`${resource}: limite massimo di sicurezza superato`);for(const row of page){const identity=key(row);if(identity==null||identity==='')throw new Error(`${resource}: identità riga mancante`);const normalized=String(identity);if(seen.has(normalized))continue;seen.add(normalized);rows.push(row);if(rows.length>maxRows)throw new Error(`${resource}: limite massimo di sicurezza superato`);}if(page.length<pageSize)return {rows,requests};}throw new Error(`${resource}: limite massimo di sicurezza raggiunto`);}
```

## F. TEST RESULT

Eseguiti offline con Node v22.13.0 (`C:\Program Files\nodejs\node.exe`):

```powershell
node scripts/market-feed-hardening-smoke.mjs
node scripts/market-egress-rollout-smoke.mjs
node scripts/market-snapshot-retention-smoke.mjs --strict
Get-ChildItem scripts -Filter 'market-*-smoke.mjs' | ForEach-Object { node $_.FullName; if ($LASTEXITCODE) { throw $_.Name } }
git diff --check
```

Risultati: 24/24 suite Market PASS, incluse le due suite egress e strict retention.
Il preview server locale è necessario per i test browser (`node scripts/preview-server.mjs`).
Il test hardening è stato rieseguito dopo il passaggio alla vista invoker reale con RLS.
Test nuovi: exact daily prices-only, zero catalogo anche con unresolved, queue/auth,
nessun import GitHub, singolo bulk e nessun retry, permessi RPC effettivi, timestamp
concorrente protetto su PostgreSQL/WASM; cron rollout/rollback e canary SQL eseguiti
con stub pg_cron/pg_net locali, schedules/guardia DST reali. Nessun pg_net remoto.
`git diff --check` PASS (solo warning CRLF). Nessun test guest/UI estraneo cambiato.


## G. EXACT LIVE ROLLOUT ORDER

1. Eseguire H1 del file verification. Confermare IDs/nome/schedule, entrambi PAUSED,
   zero run attivi, timezone cron UTC/GMT, un solo secret Vault non vuoto. Verificare
   anche che vecchie richieste pg_net non siano ancora in volo: un cron pausato non
   cancella richieste già accodate. Attendere il completamento/timeout, non cancellarle.
   Salvare come backup il sorgente attuale v57 e la configurazione dei due job
   tramite gli strumenti di lettura autorizzati al momento del rollout. Non stampare secrets.
2. Confermare ancora active sync runs = 0 subito prima delle modifiche.
3. Applicare SOLO `supabase/manual/market-feed-queue-probe.sql`. Eseguire H2:
   invoker, boolean, grant backend, BYPASSRLS service_role già esistente, probe boolean.
   Se non concordano, fermarsi con cron pausati; non aggiungere grant anon/auth.
4. Deploy `market-sync` dal file COMPLETO incluso nel bundle, `verify_jwt=false`.
5. Deploy `market-refresh-queue-cached` dal file COMPLETO incluso, `verify_jwt=false`.
   Usare le env esistenti, nessun set secrets. Leggere metadata/sorgenti appena
   distribuiti: confrontare col manifest e accertare che il wrapper non importi GitHub.
   Il secret gate HTTP resta obbligatorio; JWT disattivato non rende anonima la funzione.
6. Eseguire `market-egress-cron-rollout.sql` fino alla SELECT finale. Il file intero
   lascia i job pausati: REACTIVATE è commentato intenzionalmente. Controllare endpoint,
   schedule, guardia e payload. Non usare schedule/unschedule o creare altri job.
7. Eseguire UNA volta `market-egress-queue-canary.sql`; annotare il request ID restituito.
   Commit prima della lettura risposta: pg_net invia dopo commit.
8. In una nuova query H3, trovare quell'ID: HTTP 200, `ok:true`, `mode:queue_targeted`,
   status `skipped`/`deferred`, reason `queue_empty`/`awaiting_daily_full`.
   Nei log della stessa invocazione: `market_sync_feed_bytes=0`,
   `market_sync_storage_bytes_read=0`, cache counters 0 e un solo probe boolean.
   Nessun nuovo sync run e nessun acknowledgement. HTTP 503/401, risposta assente,
   log assenti o provenienti dalla vecchia versione => NON riattivare.
9. NON invocare un daily manuale in questo rollout. La chiave giornaliera e
   ignore-duplicates impediscono duplicati, ma non il secondo download né un run
   parziale nello stesso giorno. Il primo daily reale è il canary prezzi. Attendere
   il prossimo slot 03:00 Europe/Rome; non forzare `scheduled:false` né recover ripetuti.
10. Dopo canary queue positivo, eseguire separatamente:
    `select cron.alter_job(job_id:=5, active:=true);`
11. Poi: `select cron.alter_job(job_id:=6, active:=true);`
    Eseguire la SELECT stati in H4. Nessun altro job riattivato.
12. Ispezionare primo polling e primo daily con H4 + log Edge: zero feed queue;
    daily massimo un Price Guide, nessun catalogo, cache bypass, Storage zero;
    snapshot giornalieri, current avanzato, nessun :current nuovo/duplicato/evento
    con ID uguali. Anomalie/eventi possono legittimamente essere zero se l'input
    non li richiede: non generare osservazioni sintetiche live. Un run partial/failed
    richiede lettura dell'errore prima di recovery; non attivare retry automatici.

Deploy tramite CLI, se è lo strumento scelto dall'operatore (comandi NON eseguiti qui):

```sh
supabase functions deploy market-sync --project-ref gonycawupahawocqafcf --no-verify-jwt
supabase functions deploy market-refresh-queue-cached --project-ref gonycawupahawocqafcf --no-verify-jwt
```

Sono equivalenti a due deploy MCP degli stessi file con `verify_jwt:false`.
Non applicare tutte le migration del repository. Nessun cleanup/Storage retention.
Firma alter_job verificata su [pg_cron ufficiale](https://github.com/citusdata/pg_cron#altering-a-cron-job);
opzione deploy documentata da [Supabase](https://supabase.com/docs/guides/functions/deploy).


## H. EXACT LIVE VERIFICATION QUERIES

FILE: `supabase/manual/market-egress-live-verification.sql`

```sql
-- READ ONLY. Run sections at the indicated steps, not before their prerequisites.
-- H1: BEFORE rollout. Expect IDs 5/6, active=false, runs=0, UTC/GMT timezone.
select jobid,jobname,schedule,active,
  substring(command from 'functions/v1/([a-zA-Z0-9_-]+)') endpoint
from cron.job where jobid in (5,6) order by jobid;
select count(*) active_sync_runs from public.market_provider_sync_runs where status='running';
select count(*) queued_market_http_requests from net.http_request_queue
where url like 'https://gonycawupahawocqafcf.supabase.co/functions/v1/market%';
select current_setting('cron.timezone',true) cron_timezone;
select count(*) nonempty_sync_secrets from vault.decrypted_secrets
where name='market_sync_secret' and nullif(decrypted_secret,'') is not null;

-- H2: AFTER RPC installation. Expect false for prosecdef, invoker fixed path,
-- anon/auth false, service true; service_role should retain its existing BYPASSRLS.
select p.prosecdef,p.provolatile,p.proconfig,pg_get_function_result(p.oid) result_type
from pg_proc p where p.oid='public.market_refresh_queue_pending()'::regprocedure;
select r,has_function_privilege(r,'public.market_refresh_queue_pending()','EXECUTE') can_execute
from unnest(array['anon','authenticated','service_role']) r;
select rolname,rolbypassrls from pg_roles where rolname='service_role';
select t,has_table_privilege('service_role',t,'SELECT') backend_can_read
from unnest(array['public.market_monitored_printings','public.card_printings',
  'public.market_provider_printings','public.market_price_snapshots',
  'public.collection_items','public.deck_cards','public.decks','public.market_watch_items']) t;
begin read only;
set local role service_role;
select public.market_refresh_queue_pending() pending;
rollback;

-- H3: AFTER queue canary. Match id with queue_canary_request_id from the invocation.
-- Do not infer success from pg_cron status: net.http_post is asynchronous.
select id,status_code,timed_out,error_msg,left(content,500) response,
  headers->>'sb-request-id' edge_request_id,created
from net._http_response where created>=now()-interval '15 minutes'
order by id desc limit 20;
-- Also inspect Edge logs for this invocation: queue_targeted, feed_bytes=0,
-- storage_bytes_read=0, event empty_skip_feed or deferred_until_daily.
-- SQL cannot prove Edge byte counters; do not treat missing logs as zero.

-- H4: AFTER cron alteration/reactivation and first real daily.
select jobid,jobname,schedule,active,command from cron.job where jobid in (5,6) order by jobid;
select jobid,status,start_time,end_time,return_message from cron.job_run_details
where jobid in (5,6) and start_time>=now()-interval '2 days'
order by start_time desc limit 20;
select id,provider,status,started_at,finished_at,error_code,error_message,metadata
from public.market_provider_sync_runs where started_at>=now()-interval '2 days'
order by started_at desc limit 10;
select tgname,pg_get_triggerdef(oid) definition from pg_trigger
where tgrelid='public.market_price_snapshots'::regclass and not tgisinternal;
select count(*) daily_rows,min(captured_at),max(captured_at),
  count(*) filter(where observation_key like '%:current') rolling_rows,
  count(*) filter(where is_anomalous) anomalous_rows
from public.market_price_snapshots where provider='cardmarket'
  and captured_at>=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC';
select count(*) duplicate_groups from (
  select provider,observation_key,price_type from public.market_price_snapshots
  where captured_at>=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC'
  group by provider,observation_key,price_type having count(*)>1
) d;
select count(*) invalid_event_ids from public.market_price_events
where detected_at>=now()-interval '2 days' and previous_snapshot_id=current_snapshot_id;
select count(*) current_rows,max(captured_at) latest_current from public.market_current_price_snapshots
where provider='cardmarket';
-- Compare runs/snapshot/current timestamps before and after daily. Zero events or
-- anomalies can be legitimate with unchanged/non-anomalous input; do not manufacture them live.
```
## I. SAFE TO DEPLOY = YES

YES per il pacchetto coordinato con l'ordine e i gate sopra, non per il solo wrapper.
Non restano blocker locali del P0. I controlli live sono passi del rollout, NON
risultati già osservati in questa preparazione. Se un gate fallisce, mantenere PAUSED.
Non viene dichiarato testato un deploy remoto o un feed reale sotto quota Free.

## Rollback code / cron / safe-stop

- SAFE-STOP: eseguire solo il primo blocco PAUSE del file rollback. Nessun restore
  di dati; lasciare le nuove funzioni deployate ma non schedulate.
- Rollback cron: file completo `market-egress-rollout-rollback.sql`, sempre PAUSED.
  Ripristina gli URL/body/guardia/schedule precedenti forniti dall'utente. Non
  riattiva automaticamente la pipeline Storage pericolosa.
- Rollback code: dopo stop e drenaggio richieste ripristinare il backup v57 salvato
  al punto 1 e, solo se serve riprodurre il vecchio daily, il wrapper v2 archiviato
  nel bundle. Quel wrapper scarica di nuovo il worker remoto pinnato: lasciare
  entrambi i cron pausati fino a una scelta esplicita. Non confondere il diff locale
  rispetto a Git HEAD con un backup verificato del deploy v57.
- La RPC invoker può restare installata/inutilizzata: niente DROP, niente restore
  di tabelle, nessuna modifica a trigger/migration record/retention.


## Manual queue canary SQL — execute only at step 7

```sql
-- MANUAL ONLY, after both deploys and paused cron alteration. No feed/DB data writes
-- by the Edge handler; net.http_post itself queues an HTTP request in pg_net.
begin;
do $guard$
begin
  if (select count(*) from cron.job where jobid in (5,6) and not active) <> 2
     or exists(select 1 from public.market_provider_sync_runs where status='running') then
    raise exception 'Both jobs must be paused and active sync runs zero';
  end if;
  if (select count(*) from vault.decrypted_secrets
      where name='market_sync_secret' and nullif(decrypted_secret,'') is not null) <> 1 then
    raise exception 'Expected one Vault sync secret';
  end if;
end;
$guard$;
select net.http_post(
  url := 'https://gonycawupahawocqafcf.supabase.co/functions/v1/market-refresh-queue-cached',
  headers := jsonb_build_object('Content-Type','application/json','x-market-sync-secret',
    (select decrypted_secret from vault.decrypted_secrets where name='market_sync_secret')),
  body := '{"refreshQueue":true}'::jsonb,
  timeout_milliseconds := 30000
) as queue_canary_request_id;
commit;
-- Record the returned ID; inspect its response in a NEW query after this commit.
-- Never print request headers or decrypted_secret.
```

## Canonical artifacts and deployment configuration

## Fonte canonica e payload

Unica definizione eseguibile di `market_refresh_queue_pending()`:
`supabase/manual/market-feed-queue-probe.sql`. Le copie nel bundle e nei blocchi
Markdown sono generate da quella fonte, non altre migration da applicare.
Il worker e il wrapper condividono una policy inline verificata identica dal test.
La vista `market_monitored_printings` è SECURITY INVOKER: i grant includono anche
le quattro tabelle sottostanti. Solo SELECT al backend; nessun grant frontend.

Daily esatto: `{"mode":"daily_full","scheduled":true,"pricesOnly":true,"recoverStale":true}`.
Tutti i parametri sono consumati. `source` non è necessario e viene omesso.
`pricesOnly:true` salta il resolver e il catalogo anche con mapping irrisolte;
quelle restano pending fino a un job resolver amministrativo esplicito.
Il nuovo daily non pretende di risolvere nuove mapping senza catalogo.
`scheduled:true` aggiunge la guardia Edge alle 03 Europe/Rome; il comando SQL ha
la stessa guardia. `0 1,2 * * *` UTC produce una sola chiamata effettiva al giorno,
compresi i cambi DST. La queue conserva `5,20,35,50 * * * *`.


```toml
[functions.market-sync]
verify_jwt = false

[functions.market-refresh-queue-cached]
verify_jwt = false
```

## SHA-256 manifest

```json
[
  {
    "path": "supabase/functions/market-sync/index.ts",
    "bytes": 107567,
    "sha256": "0f8cf6e91e9102b74f3dcd121eafdee16323756503946595349b7c885e3fe707"
  },
  {
    "path": "supabase/functions/market-refresh-queue-cached/index.ts",
    "bytes": 2351,
    "sha256": "9decc54ad984c251883fe6c42643807710395eadfec7424d6969861b8a58bafb"
  },
  {
    "path": "supabase/config.toml",
    "bytes": 103,
    "sha256": "7d8793c5df7caee21dfcf3d33a4b4b6d467ac33f460e2cd3d6ed44167f1a118e"
  },
  {
    "path": "supabase/manual/market-feed-queue-probe.sql",
    "bytes": 1410,
    "sha256": "8fa866663ea4f613e70a75cf3df21a91ddf1c1032b8194cc972f4b94c3e4cc11"
  },
  {
    "path": "supabase/manual/market-egress-cron-rollout.sql",
    "bytes": 3052,
    "sha256": "be76186f7c1a34ac9611f3388b5b9323c9f5ad44694ce493163710b0476f8f60"
  },
  {
    "path": "supabase/manual/market-egress-rollout-rollback.sql",
    "bytes": 2344,
    "sha256": "f70525a5ceef4b1c526f4fd3609c738552827c609f4fb59eaab80a4ff18cc5f3"
  },
  {
    "path": "supabase/manual/market-egress-queue-canary.sql",
    "bytes": 1209,
    "sha256": "5464b702a4aaede63c783e1fc04eaf41f68ef8f6fa63c678c557458bd8ce589e"
  },
  {
    "path": "supabase/manual/market-egress-live-verification.sql",
    "bytes": 4115,
    "sha256": "e34e626b1714824cd89115c27734ebafd509ef1e7aaa7cefd38dcb3a71674445"
  },
  {
    "path": "docs/market-egress-rollout-operator-notes.md",
    "bytes": 7905,
    "sha256": "afe1e886d956c2b0863b2b7b941bc8d44664470e4b3036333cc09925d73f9352"
  },
  {
    "path": "docs/audit-snapshots/market-egress-2026-10-04/market-refresh-queue-cached-v2.ts",
    "bytes": 3906,
    "sha256": "980a0df1583d4d22a82d17b964f4fb85fa9895074f2c76926880b7e5f2b4f3cc"
  }
]
```
