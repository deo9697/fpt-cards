import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

const source = fs.readFileSync(new URL('../supabase/functions/market-sync/index.ts', import.meta.url), 'utf8');
let requests = [], finished = [], availableRows = [], priceLoads = 0;
const context = vm.createContext({
  URLSearchParams, URL, Response, console, setTimeout, clearTimeout, AbortSignal,
  Deno: { env: { get: key => key === 'SUPABASE_URL' ? 'https://example.supabase.co' : 'test' }, serve: () => {} },
  fetch: async (url, options) => {
    const parsed = new URL(url);
    requests.push(parsed);
    assert.equal(options.method, 'POST');
    assert.equal(JSON.parse(options.body).p_provider, 'cardmarket');
    const rows = parsed.searchParams.has('refresh_requested_at')
      ? availableRows.filter(row => row.refresh_requested_at != null) : availableRows;
    const offset = Number(parsed.searchParams.get('offset'));
    const limit = Number(parsed.searchParams.get('limit'));
    return new Response(JSON.stringify(rows.slice(offset, offset + limit)));
  },
});
vm.runInContext(stripTypeScriptTypes(source), context);
vm.runInContext("rpc=async()=> 'run'; finish=async(...args)=>captureFinish(args);", context);
context.captureFinish = args => finished.push(args);
const provider = {name:'cardmarket', getPriceMetadata:()=>({status:'available'}), loadPrices:async()=>{priceLoads++;}};
// The real worker exits without loading the external feed when the queue is empty.
const result = await context.syncProvider(provider, {priorityOnly:true, pricesOnly:true});
assert.equal(result.reason, 'no_pending_refresh_requests');
assert.equal(requests.length, 1);
assert.equal(requests[0].searchParams.get('refresh_requested_at'), 'not.is.null');
assert.equal(priceLoads, 0);
assert.equal(finished.length, 1);
// Filtering survives every page; pending rows are neither lost nor duplicated.
requests = [];
availableRows = Array.from({length:1100}, (_, id) => ({id, refresh_requested_at:id%2?'2026-09-26':null}));
const paged = await context.rpcPages('market_sync_targets', {p_provider:'cardmarket'}, {filters:{refresh_requested_at:'not.is.null'}, order:'id.asc'});
assert.equal(paged.rows.length, 550);
assert.equal(new Set(paged.rows.map(row=>row.id)).size, 550);
assert.equal(requests.length, 2);
assert.ok(requests.every(url=>url.searchParams.get('refresh_requested_at')==='not.is.null'));
// Daily/full sync still receives every target.
requests = [];
const full = await context.rpcPages('market_sync_targets', {p_provider:'cardmarket'}, {order:'id.asc'});
assert.equal(full.rows.length, 1100);
assert.ok(requests.every(url=>!url.searchParams.has('refresh_requested_at')));
console.log('PASS: empty queue, filtered pagination, unchanged full sync');
