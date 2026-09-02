// Deploy manualmente solo dopo aver applicato la migration Market Watch.
// Il cron delle 03:00 Europe/Rome è intenzionalmente escluso dalla migration.
import {CardTraderProvider,CardmarketPriceGuideProvider,CARDMARKET_RESOLUTION_STATES,isAuthorizedCardmarketMapping} from '../../../market/providers.js';

const supabaseUrl=Deno.env.get('SUPABASE_URL')||'';
const serviceKey=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||'';
const syncSecret=Deno.env.get('MARKET_SYNC_SECRET')||'';

Deno.serve(async request=>{
  if(request.method!=='POST')return json({error:'method_not_allowed'},405);
  if(!supabaseUrl||!serviceKey)return json({error:'backend_not_configured'},503);
  if(!syncSecret)return json({error:'sync_secret_not_configured'},503);
  if(request.headers.get('x-market-sync-secret')!==syncSecret)return json({error:'unauthorized'},401);
  const payload=await request.json().catch(()=>({}));
  const dryTargetPrintingIds=printingIds(payload?.dryTargetPrintingIds);
  const canaryPrintingIds=printingIds(payload?.canaryPrintingIds);
  if(payload?.dryTargetPrintingIds&&!dryTargetPrintingIds.length)return json({error:'invalid_dry_target_printing_ids'},400);
  if(payload?.canaryPrintingIds&&!canaryPrintingIds.length)return json({error:'invalid_canary_printing_ids'},400);
  if(dryTargetPrintingIds.length&&canaryPrintingIds.length)return json({error:'dry_target_and_canary_are_mutually_exclusive'},400);
  if(payload?.scheduled===true&&!isThreeInRome(new Date()))return json({ok:true,status:'skipped',reason:'outside_03_europe_rome'});
  const providers=[
    new CardTraderProvider({token:Deno.env.get('CARDTRADER_API_TOKEN')||''}),
    new CardmarketPriceGuideProvider({catalogUrl:Deno.env.get('CARDMARKET_PRODUCT_CATALOG_URL')||'',priceGuideUrl:Deno.env.get('CARDMARKET_PRICE_GUIDE_URL')||''})
  ];
  const pricesOnly=payload?.pricesOnly===true||payload?.scheduled===true;
  if(canaryPrintingIds.length&&pricesOnly)return json({error:'canary_requires_full_mode'},400);
  if(dryTargetPrintingIds.length){
    const cardmarket=providers.find(provider=>provider.name==='cardmarket');
    return json(await dryTargetCardmarket(cardmarket,dryTargetPrintingIds));
  }
  const results=[];
  for(const provider of providers)results.push(await syncProvider(provider,{recoverStale:payload?.recoverStale===true,pricesOnly,targetPrintingIds:canaryPrintingIds}));
  return json({ok:results.some(row=>['succeeded','partial'].includes(row.status)),mode:canaryPrintingIds.length?'canary':pricesOnly?'prices_only':'full',results});
});

async function syncProvider(provider:any,{recoverStale=false,pricesOnly=false,targetPrintingIds=[] as string[]}={}){
  const metadata=provider.getPriceMetadata();
  if(metadata.status==='unavailable')return {provider:provider.name,status:'unavailable',reason:'secret_or_feed_missing'};
  if(recoverStale)await releaseProviderSync(provider.name);
  const runId=await rpc('begin_market_provider_sync',{p_provider:provider.name});
  if(!runId)return {provider:provider.name,status:'skipped',reason:'sync_already_running'};
  let requestCount=0,snapshots=0,failures=0,feedStats:any=null,targetPages=0,printingPages=0,printingRows=0;
  try{
    const targetResult=await rpcPages('market_sync_targets',{p_provider:provider.name},{order:'printing_id.asc,variant_key.asc.nullslast,mapping_id.asc.nullslast',key:(row:any)=>row.mapping_id||`${row.printing_id}:${row.variant_key||'default'}`});
    const allTargets=targetResult.rows;targetPages=targetResult.requests;
    const selectedIds=new Set(targetPrintingIds),targets=selectedIds.size?allTargets.filter((target:any)=>selectedIds.has(String(target.printing_id))):allTargets;
    const unique=new Map<string,any>();
    for(const target of targets){const key=`${target.printing_id}:${target.variant_key||'default'}`;if(!unique.has(key))unique.set(key,target);}
    let resolvedTargets=[...unique.values()];
    if(provider.name==='cardmarket'){
      if(pricesOnly){feedStats=await provider.loadPrices(resolvedTargets);requestCount+=1;}
      else{
        const catalogStats=await provider.loadCatalog(resolvedTargets);requestCount+=2;
        const printingResult=await listCardPrintings(),internalPrintings=printingResult.rows;
        printingPages=printingResult.requests;printingRows=internalPrintings.length;
        resolvedTargets=await resolveCardmarketTargets(provider,resolvedTargets,internalPrintings);
        const priceStats=await provider.loadPrices(resolvedTargets);requestCount+=1;
        feedStats={...catalogStats,...priceStats};
      }
    }
    const pendingSnapshots=[];
    for(const target of resolvedTargets){
      try{
        const authorized=provider.name==='cardmarket'?isAuthorizedCardmarketMapping(target):['resolved','manual'].includes(target.resolution_status);
        if(!authorized||!target.mapping_id){failures++;continue;}
        const value=await provider.getCurrentPrice(target);requestCount+=provider.name==='cardtrader'?1:0;
        if(value.status!=='available')continue;
        const capturedAt=value.capturedAt||new Date().toISOString(),day=capturedAt.slice(0,10);
        for(const price of pricesForTarget(value.prices,target)){
          const eur=value.currency==='EUR'?price.value:null;
          pendingSnapshots.push({
            printing_id:target.printing_id,provider_mapping_id:target.mapping_id,provider:provider.name,price_type:price.type,
            original_currency:value.currency,original_price:price.value,normalized_currency:'EUR',normalized_price:eur,
            language:target.language||'',condition_reference:value.conditionReference||target.condition_reference||'',foil:target.foil,
            available_quantity:value.availableQuantity,sample_size:value.sampleSize,source_updated_at:value.sourceUpdatedAt||null,captured_at:capturedAt,
            observation_key:`${target.mapping_id}:${day}`,metadata:{variantKey:target.variant_key||'default',productUrl:target.provider_metadata?.productUrl||null,
              resolverStatus:target.provider_metadata?.resolverStatus||null,resolverVersion:target.provider_metadata?.resolverVersion||null,priceScope:target.provider_metadata?.priceScope||null}
          });snapshots++;
        }
      }catch(error:any){failures++;await recordMappingError(target.mapping_id,error);}
    }
    for(let index=0;index<pendingSnapshots.length;index+=250)await rest('market_price_snapshots?on_conflict=provider,observation_key,price_type','POST',pendingSnapshots.slice(index,index+250),{'Prefer':'resolution=ignore-duplicates,return=minimal'});
    const mappingStates=resolvedTargets.reduce((counts:any,target:any)=>{const key=target.provider_metadata?.resolverStatus||target.resolution_status||'unresolved';counts[key]=(counts[key]||0)+1;return counts;},{});
    const status=failures&&snapshots?'partial':failures&&!snapshots?'failed':'succeeded';
    await finish(runId,status,{request_count:requestCount,attempt_count:1,error_code:failures?'target_failures':null,error_message:failures?`${failures} mapping non aggiornati`:null,metadata:{targets:unique.size,snapshots}});
    return {provider:provider.name,status,targets:unique.size,requestedTargets:selectedIds.size||null,snapshots,failures,feedStats,mappingStates,pagination:{targetPages,targetRows:allTargets.length,printingPages,printingRows}};
  }catch(error:any){await finish(runId,'failed',{request_count:requestCount,attempt_count:1,error_code:error?.code||'sync_failed',error_message:String(error?.message||error).slice(0,500)});return {provider:provider.name,status:'failed',error:String(error?.message||error)};}
}

async function dryTargetCardmarket(provider:any,ids:string[]){
  if(provider.getPriceMetadata().status==='unavailable')return {ok:false,mode:'dry_target',provider:'cardmarket',status:'unavailable',reason:'secret_or_feed_missing'};
  const printingResult=await listCardPrintings(),allPrintings=printingResult.rows,wanted=new Set(ids),targets=allPrintings.filter((row:any)=>wanted.has(String(row.id))).map(printingTarget);
  const catalogStats=await provider.loadCatalog(targets),resolved:any[]=[];
  for(const target of targets)resolved.push({target,resolution:await provider.resolvePrinting(target,{internalPrintings:allPrintings})});
  const authorized=resolved.filter((row:any)=>[CARDMARKET_RESOLUTION_STATES.EXACT,CARDMARKET_RESOLUTION_STATES.PROVIDER_AGGREGATE].includes(row.resolution.status)).map((row:any)=>({
    ...row.target,resolution_status:'resolved',provider_product_id:row.resolution.candidate?.providerProductId,provider_metadata:{resolverStatus:row.resolution.status,priceScope:row.resolution.priceScope}
  }));
  const priceStats=await provider.loadPrices(authorized),prices=new Map();
  for(const target of authorized){const value=await provider.getCurrentPrice(target);prices.set(String(target.printing_id),pricesForTarget(value.prices||[],target));}
  return {ok:true,mode:'dry_target',provider:'cardmarket',requested:ids.length,found:targets.length,catalogStats,priceStats,pagination:{printingPages:printingResult.requests,printingRows:allPrintings.length},results:resolved.map((row:any)=>({
    printingId:row.target.printing_id,cardName:row.target.card_name,setCode:row.target.set_code,rarity:row.target.rarity,status:row.resolution.status,reason:row.resolution.reason,
    providerProductId:row.resolution.candidate?.providerProductId||null,priceScope:row.resolution.priceScope||null,prices:prices.get(String(row.target.printing_id))||[]
  }))};
}

async function resolveCardmarketTargets(provider:any,targets:any[],internalPrintings:any[]){
  const bodies=[];
  for(const target of targets){if(target.resolution_status==='manual'&&target.mapping_id)continue;bodies.push(cardmarketResolutionBody(target,await provider.resolvePrinting(target,{internalPrintings})));}
  const saved=[];
  for(let index=0;index<bodies.length;index+=200){const response=await fetch(`${supabaseUrl}/rest/v1/market_provider_printings?on_conflict=printing_id,provider,variant_key`,{method:'POST',headers:{...headers(),Prefer:'resolution=merge-duplicates,return=representation'},body:JSON.stringify(bodies.slice(index,index+200))});if(!response.ok)throw new Error(`mapping cardmarket: ${response.status} ${await response.text()}`);saved.push(...await response.json());}
  const byPrinting=new Map(saved.map((row:any)=>[row.printing_id,row]));return targets.map(target=>{const row:any=byPrinting.get(target.printing_id);return row?{...target,mapping_id:row.id,provider_product_id:row.provider_product_id,provider_expansion_id:row.provider_expansion_id,resolution_status:row.resolution_status,provider_metadata:row.provider_metadata,variant_key:row.variant_key}:target;});
}
function cardmarketResolutionBody(target:any,resolution:any){
  const candidate=resolution.candidate||{},now=new Date().toISOString(),active=[CARDMARKET_RESOLUTION_STATES.EXACT,CARDMARKET_RESOLUTION_STATES.PROVIDER_AGGREGATE].includes(resolution.status);
  const databaseStatus=active?'resolved':resolution.status===CARDMARKET_RESOLUTION_STATES.AMBIGUOUS?'ambiguous':'unresolved';
  const previousProductId=target.provider_product_id||null,providerProductId=active?(candidate.providerProductId||candidate.provider_product_id||null):previousProductId;
  return {printing_id:target.printing_id,provider:'cardmarket',variant_key:'default',provider_product_id:providerProductId,
    provider_expansion_id:candidate.providerExpansionId||candidate.provider_expansion_id||null,language:target.language||'',condition_reference:'Price Guide Cardmarket',foil:target.foil,
    edition:target.edition||'',resolution_status:databaseStatus,confidence:active?1:0,resolved_at:active?now:null,last_checked_at:now,last_error:null,
    provider_metadata:{...(target.provider_metadata||{}),active,resolverStatus:resolution.status,resolverVersion:resolution.resolverVersion,reason:resolution.reason,priceScope:resolution.priceScope,
      productUrl:active?(candidate.productUrl||null):(target.provider_metadata?.productUrl||null),productName:active?(candidate.cardName||candidate.name||null):(target.provider_metadata?.productName||null),
      expansion:active?(candidate.setName||candidate.expansion||null):(target.provider_metadata?.expansion||null),rarity:active?(candidate.rarity||null):(target.provider_metadata?.rarity||null),
      foil:active?(candidate.foil??null):(target.provider_metadata?.foil??null),evidence:resolution.evidence||null,candidateCount:resolution.candidates?.length||0,
      supersededProductId:!active&&previousProductId?previousProductId:null}};
}

async function listCardPrintings(){return restPages('card_printings?select=id,game,catalog_card_id,card_name,set_code,set_name,rarity&game=eq.yugioh&order=id.asc',{key:(row:any)=>row.id});}
function printingTarget(row:any){return {printing_id:row.id,game:row.game,catalog_card_id:row.catalog_card_id,card_name:row.card_name,set_code:row.set_code,set_name:row.set_name,rarity:row.rarity,language:'',edition:'',foil:null};}
function pricesForTarget(prices:any[],target:any){const foil=target.foil===true;return (prices||[]).filter(price=>foil?String(price.type).startsWith('foil_'):!String(price.type).startsWith('foil_'));}
function printingIds(value:any){if(!Array.isArray(value)||value.length>20)return[];const ids=[...new Set(value.map(String))];return ids.length&&ids.every(id=>/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))?ids:[];}

async function rpc(name:string,body:Record<string,unknown>){const response=await fetch(`${supabaseUrl}/rest/v1/rpc/${name}`,{method:'POST',headers:headers(),body:JSON.stringify(body)});if(!response.ok)throw new Error(`${name}: ${response.status} ${await response.text()}`);const text=await response.text();return text?JSON.parse(text):null;}
async function rpcPages(name:string,body:Record<string,unknown>,options:any={}){return fetchPages(`${supabaseUrl}/rest/v1/rpc/${name}${options.order?`?order=${encodeURIComponent(options.order)}`:''}`,{method:'POST',body:JSON.stringify(body),key:options.key,resource:name});}
async function rest(table:string,method:string,body:unknown,extra:Record<string,string>={}){const response=await fetch(`${supabaseUrl}/rest/v1/${table}`,{method,headers:{...headers(),...extra},body:body==null?undefined:JSON.stringify(body)});if(!response.ok)throw new Error(`${table}: ${response.status} ${await response.text()}`);return response;}
async function restPages(path:string,options:any={}){return fetchPages(`${supabaseUrl}/rest/v1/${path}`,{method:'GET',key:options.key,resource:path});}
async function fetchPages(url:string,{method='GET',body,key=(row:any)=>row.id,resource='resource',pageSize=500,maxRows=20000}:any={}){const rows:any[]=[],seen=new Set<string>();let requests=0;for(let from=0;from<=maxRows;from+=pageSize){const to=from+pageSize-1,response=await fetch(url,{method,headers:{...headers(),Range:`${from}-${to}`,'Range-Unit':'items'},body});if(response.status===416)return {rows,requests};if(!response.ok)throw new Error(`${resource} pagina ${requests+1}: ${response.status} ${await response.text()}`);const page=await response.json();if(!Array.isArray(page))throw new Error(`${resource}: risposta paginata non valida`);requests++;if(from===maxRows&&page.length)throw new Error(`${resource}: limite massimo di sicurezza superato`);for(const row of page){const identity=key(row);if(identity==null||identity==='')throw new Error(`${resource}: identità riga mancante`);const normalized=String(identity);if(seen.has(normalized))continue;seen.add(normalized);rows.push(row);if(rows.length>maxRows)throw new Error(`${resource}: limite massimo di sicurezza superato`);}if(page.length<pageSize)return {rows,requests};}throw new Error(`${resource}: limite massimo di sicurezza raggiunto`);}
async function releaseProviderSync(provider:string){const response=await fetch(`${supabaseUrl}/rest/v1/market_provider_sync_runs?provider=eq.${encodeURIComponent(provider)}&status=eq.running`,{method:'PATCH',headers:{...headers(),Prefer:'return=minimal'},body:JSON.stringify({status:'failed',finished_at:new Date().toISOString(),error_code:'manual_recovery',error_message:'Lock recuperato dopo interruzione del worker'})});if(!response.ok)throw new Error(`sync recovery: ${response.status} ${await response.text()}`);}
async function finish(id:string,status:string,fields:Record<string,unknown>){const response=await fetch(`${supabaseUrl}/rest/v1/market_provider_sync_runs?id=eq.${encodeURIComponent(id)}`,{method:'PATCH',headers:{...headers(),Prefer:'return=minimal'},body:JSON.stringify({status,finished_at:new Date().toISOString(),last_success_at:['succeeded','partial'].includes(status)?new Date().toISOString():null,...fields})});if(!response.ok)throw new Error(`sync finish: ${response.status} ${await response.text()}`);}
async function recordMappingError(id:string,error:any){if(!id)return;const response=await fetch(`${supabaseUrl}/rest/v1/market_provider_printings?id=eq.${encodeURIComponent(id)}`,{method:'PATCH',headers:{...headers(),Prefer:'return=minimal'},body:JSON.stringify({last_checked_at:new Date().toISOString(),last_error:String(error?.message||error).slice(0,500)})});if(!response.ok)throw new Error(`mapping error update: ${response.status}`);}
function headers(){return {'content-type':'application/json',apikey:serviceKey,Authorization:`Bearer ${serviceKey}`};}
function json(body:unknown,status=200){return new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json','cache-control':'no-store'}});}
function isThreeInRome(date:Date){return new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Rome',hour:'2-digit',hourCycle:'h23'}).format(date)==='03';}
