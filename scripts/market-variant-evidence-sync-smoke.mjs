// Integration smoke: the real inferMissingExactVariants() from market-sync/index.ts
// runs in a vm with a fake Supabase REST, and must
//  - include cards waiting in the queue (AMBIGUOUS) in the evidence pool,
//  - write "auto" decisions as resolved/confidence 1 and suggestions as ambiguous/0.5,
//  - authorize an auto-decided queue card (service-role RPC) and mark it in memory,
//  - never touch verified variants, never let a suggestion overwrite a resolved row,
//  - learn only from single-card confirmations (verified + manual variants).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { marketSyncForVm, withSharedModules } from './lib/market-sync-vm.mjs';

const source = fs.readFileSync(new URL('../supabase/functions/market-sync/index.ts', import.meta.url), 'utf8');
const upserts = [], rpcCalls = [];
let existingVariants = [];
const json = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const families = [
  // MAMO: Ultra / Starlight / Grand Master (+1 unknown extra version on Cardmarket)
  ...['mamo-a', 'mamo-b'].flatMap(id => ['Ultra Rare', 'Starlight Rare', 'Grand Master Rare'].map(rarity => ({ id: `${id}-${rarity}`, catalog_card_id: id, set_code: 'MAMO-EN018'.replace('018', id === 'mamo-a' ? '018' : '005'), rarity }))),
  { id: 'stbl-en', catalog_card_id: 'stbl', set_code: 'STBL-EN038', rarity: 'Ultra Rare' }, { id: 'stbl-it', catalog_card_id: 'stbl', set_code: 'STBL-IT038', rarity: 'Ultimate Rare' },
  { id: 'v-en', catalog_card_id: 'verified', set_code: 'VRFY-EN001', rarity: 'Ultra Rare' }, { id: 'v-en2', catalog_card_id: 'verified', set_code: 'VRFY-EN001', rarity: 'Secret Rare' },
];
const context = vm.createContext({
  URLSearchParams, URL, Response, console, setTimeout, clearTimeout, AbortSignal, TextDecoder, TextEncoder, ReadableStream, AbortController,
  Deno: { env: { get: key => key === 'SUPABASE_URL' ? 'https://example.supabase.co' : 'test' }, serve: () => {} },
  fetch: async (url, options = {}) => {
    const parsed = new URL(url), path = decodeURIComponent(parsed.pathname + parsed.search);
    const range = String(options.headers?.Range || '0-499'), from = Number(range.split('-')[0]);
    const page = rows => from > 0 ? new Response('', { status: 416 }) : json(rows);
    if (path.includes('/rpc/')) { rpcCalls.push({ name: parsed.pathname.split('/').pop(), body: JSON.parse(options.body) }); return json(null); }
    if (options.method === 'POST' && path.includes('ygo_market_variants')) { upserts.push(...JSON.parse(options.body)); return new Response('', { status: 201 }); }
    if (path.includes('ygo_rarity_aliases')) return page([]);
    if (path.includes('ygo_market_variant_set_templates')) return page([]);
    if (path.includes('ygo_market_variants') && path.includes('verified=eq.true')) return page([
      // single-card confirmation in MAMO: Ultra Rare = 1st version (lowest idProduct)
      { printing_id: 'confirmed-1', cardmarket_product_id: '20', candidate_product_ids: ['20', '21', '22', '23'] },
    ]);
    if (path.includes('ygo_market_variants')) return page(existingVariants);
    if (path.includes('card_printings?select=id,set_code,rarity')) return page([{ id: 'confirmed-1', set_code: 'MAMO-IT007', rarity: 'Ultra Rare' }]);
    if (path.includes('card_printings?select=id,catalog_card_id,set_code,rarity')) return page(families);
    throw new Error('richiesta inattesa ' + path);
  },
});
vm.runInContext(marketSyncForVm(source), withSharedModules(context));

const prices = { 904602: 1.79, 904603: 28.03, 904604: 154.19, 904605: 4550, 904550: 1.97, 904551: 48.75, 904552: 270, 904553: 3016, 244291: 9.05, 244292: 16.7, 7001: 3, 7002: 30 };
const provider = { name: 'cardmarket', prices: new Map(Object.entries(prices).map(([id, trend]) => [id, { trend }])) };
const target = (printing_id, catalog_card_id, set_code, rarity, ids, status) => ({
  mapping_id: 'm-' + printing_id, printing_id, catalog_card_id, set_code, rarity, resolution_status: 'resolved', provider_product_id: ids[0], provider_expansion_id: 'exp',
  provider_metadata: { resolverStatus: status, candidateProductIds: ids },
});
const queued = target('mamo-queue', 'mamo-a', 'MAMO-EN018', 'Ultra Rare', ['904602', '904603', '904604', '904605'], 'AMBIGUOUS');
const authorizedAggregate = target('stbl-agg', 'stbl', 'STBL-IT038', 'Ultra Rare', ['244291', '244292'], 'PROVIDER_AGGREGATE');
const suggestOnly = target('mamo-suggest', 'mamo-b', 'MAMO-EN005', 'Starlight Rare', ['904550', '904551', '904552', '904553'], 'AMBIGUOUS');
const verified = target('already-verified', 'verified', 'VRFY-EN001', 'Ultra Rare', ['7001', '7002'], 'PROVIDER_AGGREGATE');
existingVariants = [{ printing_id: 'already-verified', mapping_status: 'verified', verified: true, cardmarket_product_id: '7002', candidate_product_ids: ['7001', '7002'] }];

const result = await context.inferMissingExactVariants(provider, [queued, authorizedAggregate, suggestOnly, verified]);
const row = id => upserts.find(r => r.printing_id === id);

assert.equal(result.confirmationsUsed, 1, 'una conferma carta-per-carta letta come base di apprendimento');
assert(!row('already-verified'), 'una variante verificata non viene mai riscritta');

assert.equal(row('mamo-queue').mapping_status, 'resolved');
assert.equal(row('mamo-queue').mapping_confidence, 1);
assert.equal(row('mamo-queue').cardmarket_product_id, '904602');
assert.equal(row('mamo-queue').resolution_reason, 'evidence_auto');
assert.match(row('mamo-queue').mapping_notes, /stessa rarità confermata nel set/);
assert.match(row('mamo-queue').mapping_notes, /rarità base/);
console.log('PASS carta in coda (MAMO Ultra): rarità base + conferma nel set → decisa in automatico');

assert.deepEqual(rpcCalls.map(c => c.name), ['market_authorize_evidence_variant']);
assert.equal(rpcCalls[0].body.p_printing_id, 'mamo-queue');
assert.equal(rpcCalls[0].body.p_product_id, '904602');
assert.equal(queued.provider_metadata.resolverStatus, 'PROVIDER_AGGREGATE', 'in memoria torna autorizzata: prezzo esatto già in questo giro');
assert.equal(context.isAuthorizedCardmarketMapping(queued), true);
console.log('PASS carta in coda decisa → autorizzata via RPC service_role e prezzata già in questo giro');

assert.equal(row('stbl-agg').mapping_status, 'resolved');
assert.equal(row('stbl-agg').cardmarket_product_id, '244291');
assert.equal(authorizedAggregate.provider_metadata.resolverStatus, 'PROVIDER_AGGREGATE');
console.log('PASS aggregato già autorizzato (STBL Ultra): due indizi → variante esatta, nessuna autorizzazione extra');

const details = row('mamo-suggest');
assert.deepEqual(Object.keys(details).sort(), ['candidate_details', 'printing_id'], 'senza decisione: solo i dettagli delle versioni, nessuno stato/prodotto toccato');
assert.equal(details.candidate_details.length, 4);
assert.equal(details.candidate_details[0].rarity, 'Ultra Rare', 'V.1 = rarità base (la più economica)');
assert.deepEqual(details.candidate_details[1].among, ['Starlight Rare', 'Grand Master Rare']);
assert.equal(row('mamo-queue').candidate_details[0].price, 1.79, 'anche le righe decise portano prezzi e rarità delle versioni');
assert(!upserts.some(r => r.printing_id === 'already-verified'), 'nemmeno i dettagli toccano una variante verificata');
console.log('PASS nessun indizio → nessuna decisione, ma prezzo e rarità stimata di ogni versione per la coda admin');

// A suggestion never overwrites a resolved row.
upserts.length = 0; rpcCalls.length = 0;
existingVariants = [{ printing_id: 'mamo-b-ultra', mapping_status: 'resolved', mapping_confidence: 0.8, verified: false, cardmarket_product_id: '904551' }];
// Same set + rarity as the confirmation → the engine WOULD suggest 904550 here.
const lone = target('mamo-b-ultra', 'unknown-card', 'MAMO-EN098', 'Ultra Rare', ['904550', '904551', '904552', '904553'], 'PROVIDER_AGGREGATE');
const lone2 = target('fresh', 'unknown-card', 'MAMO-EN099', 'Ultra Rare', ['904550', '904551', '904552', '904553'], 'AMBIGUOUS');
await context.inferMissingExactVariants(provider, [lone, lone2]);
assert.deepEqual(Object.keys(row('mamo-b-ultra')).sort(), ['candidate_details', 'printing_id'], 'un suggerimento non sovrascrive una riga già risolta: solo i dettagli delle versioni');
assert.equal(row('fresh').mapping_status, 'ambiguous');
assert.equal(row('fresh').mapping_confidence, 0.5);
assert.equal(row('fresh').resolution_reason, 'evidence_suggestion');
assert.equal(row('fresh').cardmarket_product_id, '904550');
assert.equal(rpcCalls.length, 0, 'un suggerimento non autorizza nulla');
assert.equal(lone2.provider_metadata.resolverStatus, 'AMBIGUOUS');
console.log('PASS suggerimento: scritto come ambiguous/0,5, resta in coda, mai sopra una riga risolta');
// Regression (found in prod 2026-11-17): loadPrices kept only AUTHORIZED mappings'
// prices, so queued cards had no prices and the engine could never decide them.
const guideRows = [...Array.from({ length: 1000 }, (_, i) => ({ idProduct: 1000000 + i, trend: 1 })), { idProduct: 904602, trend: 1.79 }, { idProduct: 904603, trend: 28 }, { idProduct: 244291, trend: 9.05 }, { idProduct: 777, trend: 5 }];
const Provider = vm.runInContext('CardmarketPriceGuideProvider', context);
const cm = new Provider({ priceGuideUrl: 'https://downloads.s3.cardmarket.com/productCatalog/priceGuide/price_guide_3.json', fetchImpl: async () => new Response(JSON.stringify({ version: 1, createdAt: '2026-11-17', priceGuides: guideRows })) });
cm.request = async () => new Response(JSON.stringify({ version: 1, createdAt: '2026-11-17', priceGuides: guideRows }));
const queuedForPrices = target('q', 'mamo-a', 'MAMO-EN018', 'Ultra Rare', ['904602', '904603'], 'AMBIGUOUS');
const authorizedForPrices = target('a', 'stbl', 'STBL-IT038', 'Ultra Rare', ['244291'], 'PROVIDER_AGGREGATE');
const unresolvedSingle = { ...target('u', 'x', 'X-1', 'Rare', ['777'], 'UNRESOLVED') };
await cm.loadPrices([queuedForPrices, authorizedForPrices, unresolvedSingle]);
assert.equal(cm.prices.has('904602') && cm.prices.has('904603'), true, 'prezzi delle versioni candidate di una carta in coda');
assert.equal(cm.prices.has('244291'), true, 'prezzi delle carte autorizzate come prima');
assert.equal(cm.prices.has('777'), false, 'nessun prezzo per mapping non autorizzati e non ambigui');
assert.equal(context.isQueuedMultiVersionMapping({ ...queuedForPrices, resolution_status: 'manual' }), false, 'una conferma manuale non è in coda');
console.log('PASS loadPrices: tiene anche i prezzi delle versioni delle carte in coda (stesso listino)');
console.log('market-variant-evidence-sync-smoke: OK');
