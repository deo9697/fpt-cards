// Deploy manualmente solo dopo aver applicato la migration Market Watch.
// Il cron delle 03:00 Europe/Rome è intenzionalmente escluso dalla migration.
import {CardTraderProvider,CardmarketPriceGuideProvider} from '../../../market/providers.js';

const supabaseUrl=Deno.env.get('SUPABASE_URL')||'';
const serviceKey=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||'';
const syncSecret=Deno.env.get('MARKET_SYNC_SECRET')||'';

Deno.serve(async request=>{
  if(request.method!=='POST')return json({error:'method_not_allowed'},405);
  if(!supabaseUrl||!serviceKey)return json({error:'backend_not_configured'},503);
  if(!syncSecret)return json({error:'sync_secret_not_configured'},503);
  if(request.headers.get('x-market-sync-secret')!==syncSecret)return json({error:'unauthorized'},401);
  const payload=await request.json().catch(()=>({}));
  if(payload?.scheduled===true&&!isThreeInRome(new Date()))return json({ok:true,status:'skipped',reason:'outside_03_europe_rome'});
  const providers=[
    new CardTraderProvider({token:Deno.env.get('CARDTRADER_API_TOKEN')||''}),
    new CardmarketPriceGuideProvider({catalogUrl:Deno.env.get('CARDMARKET_PRODUCT_CATALOG_URL')||'',priceGuideUrl:Deno.env.get('CARDMARKET_PRICE_GUIDE_URL')||''})
  ];
  const results=[];
  for(const provider of providers)results.push(await syncProvider(provider,{recoverStale:payload?.recoverStale===true}));
  return json({ok:results.some(row=>['succeeded','partial'].includes(row.status)),results});
});

async function syncProvider(provider:any,{recoverStale=false}={}){
  const metadata=provider.getPriceMetadata();
  if(metadata.status==='unavailable')return {provider:provider.name,status:'unavailable',reason:'secret_or_feed_missing'};
  if(recoverStale)await releaseProviderSync(provider.name);
  const runId=await rpc('begin_market_provider_sync',{p_provider:provider.name});
  if(!runId)return {provider:provider.name,status:'skipped',reason:'sync_already_running'};
  let requestCount=0,snapshots=0,failures=0,feedStats:any=null;
  try{
    const targets=await rpc('market_sync_targets',{p_provider:provider.name})||[];
    const unique=new Map<string,any>();
    for(const target of targets){const key=`${target.printing_id}:${target.variant_key||'default'}`;if(!unique.has(key))unique.set(key,target);}
    if(provider.name==='cardmarket'){feedStats=await provider.load([...unique.values()]);requestCount+=3;}
    const resolvedTargets=provider.name==='cardmarket'?await resolveCardmarketTargets(provider,[...unique.values()]):[...unique.values()];
    const pendingSnapshots=[];
    for(const target of resolvedTargets){
      try{
        if(!['resolved','manual'].includes(target.resolution_status)||!target.mapping_id){failures++;continue;}
        const value=await provider.getCurrentPrice(target);requestCount+=provider.name==='cardtrader'?1:0;
        if(value.status!=='available')continue;
        const capturedAt=value.capturedAt||new Date().toISOString(),day=capturedAt.slice(0,10);
        for(const price of value.prices){
          const eur=value.currency==='EUR'?price.value:null;
          pendingSnapshots.push({
            printing_id:target.printing_id,provider_mapping_id:target.mapping_id,provider:provider.name,price_type:price.type,
            original_currency:value.currency,original_price:price.value,normalized_currency:'EUR',normalized_price:eur,
            language:target.language||'',condition_reference:value.conditionReference||target.condition_reference||'',foil:target.foil,
            available_quantity:value.availableQuantity,sample_size:value.sampleSize,source_updated_at:value.sourceUpdatedAt||null,captured_at:capturedAt,
            observation_key:`${target.mapping_id}:${day}`,metadata:{variantKey:target.variant_key||'default',productUrl:target.provider_metadata?.productUrl||null}
          });snapshots++;
        }
      }catch(error:any){failures++;await recordMappingError(target.mapping_id,error);}
    }
    for(let index=0;index<pendingSnapshots.length;index+=250)await rest('market_price_snapshots?on_conflict=provider,observation_key,price_type','POST',pendingSnapshots.slice(index,index+250),{'Prefer':'resolution=ignore-duplicates,return=minimal'});
    const mappingStates=resolvedTargets.reduce((counts:any,target:any)=>{const key=target.resolution_status||'unresolved';counts[key]=(counts[key]||0)+1;return counts;},{});
    const status=failures&&snapshots?'partial':failures&&!snapshots?'failed':'succeeded';
    await finish(runId,status,{request_count:requestCount,attempt_count:1,error_code:failures?'target_failures':null,error_message:failures?`${failures} mapping non aggiornati`:null,metadata:{targets:unique.size,snapshots}});
    return {provider:provider.name,status,targets:unique.size,snapshots,failures,feedStats,mappingStates};
  }catch(error:any){await finish(runId,'failed',{request_count:requestCount,attempt_count:1,error_code:error?.code||'sync_failed',error_message:String(error?.message||error).slice(0,500)});return {provider:provider.name,status:'failed',error:String(error?.message||error)};}
}

async function resolveCardmarketTargets(provider:any,targets:any[]){
  const bodies=[];
  for(const target of targets){if(['resolved','manual'].includes(target.resolution_status)&&target.mapping_id)continue;bodies.push(cardmarketResolutionBody(target,await provider.resolvePrinting(target)));}
  const saved=[];
  for(let index=0;index<bodies.length;index+=200){const response=await fetch(`${supabaseUrl}/rest/v1/market_provider_printings?on_conflict=printing_id,provider,variant_key`,{method:'POST',headers:{...headers(),Prefer:'resolution=merge-duplicates,return=representation'},body:JSON.stringify(bodies.slice(index,index+200))});if(!response.ok)throw new Error(`mapping cardmarket: ${response.status} ${await response.text()}`);saved.push(...await response.json());}
  const byPrinting=new Map(saved.map((row:any)=>[row.printing_id,row]));return targets.map(target=>{const row:any=byPrinting.get(target.printing_id);return row?{...target,mapping_id:row.id,provider_product_id:row.provider_product_id,provider_expansion_id:row.provider_expansion_id,resolution_status:row.resolution_status,provider_metadata:row.provider_metadata,variant_key:row.variant_key}:target;});
}
function cardmarketResolutionBody(target:any,resolution:any){
  const candidate=resolution.candidate||{},now=new Date().toISOString();
  return {printing_id:target.printing_id,provider:'cardmarket',variant_key:'default',provider_product_id:candidate.providerProductId||candidate.provider_product_id||null,
    provider_expansion_id:candidate.providerExpansionId||candidate.provider_expansion_id||null,language:target.language||'',condition_reference:'Price Guide Cardmarket',foil:target.foil,
    edition:target.edition||'',resolution_status:resolution.status,confidence:resolution.confidence||0,resolved_at:resolution.status==='resolved'?now:null,last_checked_at:now,last_error:null,
    provider_metadata:{productUrl:candidate.productUrl||null,productName:candidate.cardName||candidate.name||null,expansion:candidate.setName||candidate.expansion||null,rarity:candidate.rarity||null,evidence:resolution.evidence||null,candidateCount:resolution.candidates?.length||0}};
}

async function rpc(name:string,body:Record<string,unknown>){const response=await fetch(`${supabaseUrl}/rest/v1/rpc/${name}`,{method:'POST',headers:headers(),body:JSON.stringify(body)});if(!response.ok)throw new Error(`${name}: ${response.status} ${await response.text()}`);const text=await response.text();return text?JSON.parse(text):null;}
async function rest(table:string,method:string,body:unknown,extra:Record<string,string>={}){const response=await fetch(`${supabaseUrl}/rest/v1/${table}`,{method,headers:{...headers(),...extra},body:body==null?undefined:JSON.stringify(body)});if(!response.ok)throw new Error(`${table}: ${response.status} ${await response.text()}`);return response;}
async function releaseProviderSync(provider:string){const response=await fetch(`${supabaseUrl}/rest/v1/market_provider_sync_runs?provider=eq.${encodeURIComponent(provider)}&status=eq.running`,{method:'PATCH',headers:{...headers(),Prefer:'return=minimal'},body:JSON.stringify({status:'failed',finished_at:new Date().toISOString(),error_code:'manual_recovery',error_message:'Lock recuperato dopo interruzione del worker'})});if(!response.ok)throw new Error(`sync recovery: ${response.status} ${await response.text()}`);}
async function finish(id:string,status:string,fields:Record<string,unknown>){const response=await fetch(`${supabaseUrl}/rest/v1/market_provider_sync_runs?id=eq.${encodeURIComponent(id)}`,{method:'PATCH',headers:{...headers(),Prefer:'return=minimal'},body:JSON.stringify({status,finished_at:new Date().toISOString(),last_success_at:['succeeded','partial'].includes(status)?new Date().toISOString():null,...fields})});if(!response.ok)throw new Error(`sync finish: ${response.status} ${await response.text()}`);}
async function recordMappingError(id:string,error:any){if(!id)return;const response=await fetch(`${supabaseUrl}/rest/v1/market_provider_printings?id=eq.${encodeURIComponent(id)}`,{method:'PATCH',headers:{...headers(),Prefer:'return=minimal'},body:JSON.stringify({last_checked_at:new Date().toISOString(),last_error:String(error?.message||error).slice(0,500)})});if(!response.ok)throw new Error(`mapping error update: ${response.status}`);}
function headers(){return {'content-type':'application/json',apikey:serviceKey,Authorization:`Bearer ${serviceKey}`};}
function json(body:unknown,status=200){return new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json','cache-control':'no-store'}});}
function isThreeInRome(date:Date){return new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Rome',hour:'2-digit',hourCycle:'h23'}).format(date)==='03';}
