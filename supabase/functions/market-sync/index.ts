// Deploy manualmente solo dopo aver applicato la migration Market Watch.
// Il cron delle 03:00 Europe/Rome è intenzionalmente escluso dalla migration.
import {CardTraderProvider,CardmarketPriceGuideProvider} from '../../../market/providers.js';

const supabaseUrl=Deno.env.get('SUPABASE_URL')||'';
const serviceKey=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||'';
const syncSecret=Deno.env.get('MARKET_SYNC_SECRET')||'';

Deno.serve(async request=>{
  if(request.method!=='POST')return json({error:'method_not_allowed'},405);
  if(!supabaseUrl||!serviceKey)return json({error:'backend_not_configured'},503);
  if(syncSecret&&request.headers.get('x-market-sync-secret')!==syncSecret)return json({error:'unauthorized'},401);
  const payload=await request.json().catch(()=>({}));
  if(payload?.scheduled===true&&!isThreeInRome(new Date()))return json({ok:true,status:'skipped',reason:'outside_03_europe_rome'});
  const providers=[
    new CardTraderProvider({token:Deno.env.get('CARDTRADER_API_TOKEN')||''}),
    new CardmarketPriceGuideProvider({catalogUrl:Deno.env.get('CARDMARKET_PRODUCT_CATALOG_URL')||'',priceGuideUrl:Deno.env.get('CARDMARKET_PRICE_GUIDE_URL')||''})
  ];
  const results=[];
  for(const provider of providers)results.push(await syncProvider(provider));
  return json({ok:results.some(row=>row.status==='succeeded'),results});
});

async function syncProvider(provider:any){
  const metadata=provider.getPriceMetadata();
  if(metadata.status==='unavailable')return {provider:provider.name,status:'unavailable',reason:'secret_or_feed_missing'};
  const runId=await rpc('begin_market_provider_sync',{p_provider:provider.name});
  if(!runId)return {provider:provider.name,status:'skipped',reason:'sync_already_running'};
  let requestCount=0,snapshots=0,failures=0;
  try{
    const targets=await rpc('market_sync_targets',{p_provider:provider.name})||[];
    if(provider.name==='cardmarket'){await provider.load();requestCount+=2;}
    const unique=new Map<string,any>();
    for(const target of targets){const key=`${target.printing_id}:${target.variant_key||'default'}`;if(!unique.has(key))unique.set(key,target);}
    for(const target of unique.values()){
      if(!['resolved','manual'].includes(target.resolution_status)||!target.mapping_id){failures++;continue;}
      try{
        const value=await provider.getCurrentPrice(target);requestCount+=provider.name==='cardtrader'?1:0;
        if(value.status!=='available')continue;
        const capturedAt=value.capturedAt||new Date().toISOString(),day=capturedAt.slice(0,10);
        for(const price of value.prices){
          const eur=value.currency==='EUR'?price.value:null;
          await rest('market_price_snapshots','POST',{
            printing_id:target.printing_id,provider_mapping_id:target.mapping_id,provider:provider.name,price_type:price.type,
            original_currency:value.currency,original_price:price.value,normalized_currency:'EUR',normalized_price:eur,
            language:target.language||'',condition_reference:value.conditionReference||target.condition_reference||'',foil:target.foil,
            available_quantity:value.availableQuantity,sample_size:value.sampleSize,source_updated_at:value.sourceUpdatedAt||null,captured_at:capturedAt,
            observation_key:`${target.mapping_id}:${day}`,metadata:{variantKey:target.variant_key||'default'}
          },{'Prefer':'resolution=ignore-duplicates,return=minimal'});snapshots++;
        }
      }catch(error:any){failures++;await recordMappingError(target.mapping_id,error);}
    }
    const status=failures&&snapshots?'partial':failures&&!snapshots?'failed':'succeeded';
    await finish(runId,status,{request_count:requestCount,attempt_count:1,error_code:failures?'target_failures':null,error_message:failures?`${failures} mapping non aggiornati`:null,metadata:{targets:unique.size,snapshots}});
    return {provider:provider.name,status,targets:unique.size,snapshots,failures};
  }catch(error:any){await finish(runId,'failed',{request_count:requestCount,attempt_count:1,error_code:error?.code||'sync_failed',error_message:String(error?.message||error).slice(0,500)});return {provider:provider.name,status:'failed',error:String(error?.message||error)};}
}

async function rpc(name:string,body:Record<string,unknown>){const response=await fetch(`${supabaseUrl}/rest/v1/rpc/${name}`,{method:'POST',headers:headers(),body:JSON.stringify(body)});if(!response.ok)throw new Error(`${name}: ${response.status} ${await response.text()}`);const text=await response.text();return text?JSON.parse(text):null;}
async function rest(table:string,method:string,body:unknown,extra:Record<string,string>={}){const response=await fetch(`${supabaseUrl}/rest/v1/${table}`,{method,headers:{...headers(),...extra},body:body==null?undefined:JSON.stringify(body)});if(!response.ok)throw new Error(`${table}: ${response.status} ${await response.text()}`);return response;}
async function finish(id:string,status:string,fields:Record<string,unknown>){const response=await fetch(`${supabaseUrl}/rest/v1/market_provider_sync_runs?id=eq.${encodeURIComponent(id)}`,{method:'PATCH',headers:{...headers(),Prefer:'return=minimal'},body:JSON.stringify({status,finished_at:new Date().toISOString(),last_success_at:['succeeded','partial'].includes(status)?new Date().toISOString():null,...fields})});if(!response.ok)throw new Error(`sync finish: ${response.status} ${await response.text()}`);}
async function recordMappingError(id:string,error:any){if(!id)return;const response=await fetch(`${supabaseUrl}/rest/v1/market_provider_printings?id=eq.${encodeURIComponent(id)}`,{method:'PATCH',headers:{...headers(),Prefer:'return=minimal'},body:JSON.stringify({last_checked_at:new Date().toISOString(),last_error:String(error?.message||error).slice(0,500)})});if(!response.ok)throw new Error(`mapping error update: ${response.status}`);}
function headers(){return {'content-type':'application/json',apikey:serviceKey,Authorization:`Bearer ${serviceKey}`};}
function json(body:unknown,status=200){return new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json','cache-control':'no-store'}});}
function isThreeInRome(date:Date){return new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Rome',hour:'2-digit',hourCycle:'h23'}).format(date)==='03';}
