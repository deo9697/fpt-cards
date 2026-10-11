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
