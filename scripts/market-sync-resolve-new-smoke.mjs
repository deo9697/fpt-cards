// market-sync resolveNew (2026-10-24): il giro notturno è pricesOnly e dal
// 2026-10-04 nulla creava più mappature Cardmarket (ultima: 18/09), quindi le
// carte nuove restavano senza Market Watch. resolveNew mappa SOLO le printing
// monitorate senza alcuna mappatura e scarica il catalogo solo se ce ne sono.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { marketSyncForVm, withSharedModules } from './lib/market-sync-vm.mjs';

const source = fs.readFileSync(new URL('../supabase/functions/market-sync/index.ts', import.meta.url), 'utf8');
assert.match(source, /payload\?\.resolveNew===true/, 'modalità resolveNew esposta dalla richiesta');
let rows = [], finished = [];
const context = vm.createContext({
  URLSearchParams, URL, Response, console, setTimeout, clearTimeout, AbortSignal,
  Deno: { env: { get: key => key === 'SUPABASE_URL' ? 'https://example.supabase.co' : 'test' }, serve: () => {} },
  fetch: async url => {
    const parsed = new URL(url);
    const offset = Number(parsed.searchParams.get('offset')), limit = Number(parsed.searchParams.get('limit'));
    return new Response(JSON.stringify(rows.slice(offset, offset + limit)));
  },
});
vm.runInContext(marketSyncForVm(source),withSharedModules(context));
vm.runInContext("rpc=async()=> 'run'; finish=async(...args)=>captureFinish(args);", context);
context.captureFinish = args => finished.push(args);
const version = vm.runInContext('CARDMARKET_RESOLVER_VERSION', context);
const row = (id, extra) => ({ mapping_id: `m-${id}`, printing_id: id, game: 'yugioh', resolution_status: 'resolved', provider_metadata: { resolverVersion: version }, refresh_requested_at: null, variant_key: 'default', ...extra });
let catalogLoads = 0, catalogTargets = [];
const provider = { name: 'cardmarket', getPriceMetadata: () => ({ status: 'available' }), loadPrices: async () => {}, loadCatalog: async targets => { catalogLoads++; catalogTargets = targets; throw new Error('stop dopo il catalogo'); } };

// 1. Solo mappature esistenti (anche ambigue/non risolte): nessun download.
rows = [row('a'), row('b', { resolution_status: 'ambiguous', provider_metadata: { resolverVersion: version, resolverStatus: 'AMBIGUOUS' } }), row('c', { resolution_status: 'unresolved' })];
const quiet = await context.syncProvider(provider, { pendingResolverLimit: 500, skipPrices: true, newMappingsOnly: true });
assert.equal(catalogLoads, 0, 'nessuna carta nuova: il catalogo Cardmarket non si scarica');
assert.equal(finished.at(-1)?.[1], 'succeeded');
assert.equal(finished.at(-1)?.[2]?.metadata?.targets, 0, 'giro chiuso con zero target');
assert.equal(quiet.provider, 'cardmarket');

// 2. Una carta senza mappatura: catalogo scaricato, e al risolutore va solo lei.
rows = [...rows, row('nuova', { mapping_id: null, resolution_status: 'unresolved', provider_metadata: {} })];
await context.syncProvider(provider, { pendingResolverLimit: 500, skipPrices: true, newMappingsOnly: true });
assert.equal(catalogLoads, 1, 'carta nuova: catalogo scaricato una volta');
assert.deepEqual(Array.from(catalogTargets, target => target.printing_id), ['nuova'], 'solo la carta senza mappatura, non ambigue né non risolte');

// 3. resolvePending (manuale) continua a riprovare anche ambigue e non risolte.
catalogLoads = 0;
await context.syncProvider(provider, { pendingResolverLimit: 500, skipPrices: true });
assert.deepEqual(Array.from(catalogTargets, target => target.printing_id).sort(), ['b', 'c', 'nuova'], 'resolvePending invariato');
console.log('PASS market-sync resolveNew: catalogo scaricato solo con carte nuove, risolutore solo su quelle; resolvePending invariato');
