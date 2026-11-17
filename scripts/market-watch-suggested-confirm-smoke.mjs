// Market Watch confirmation queue with the evidence engine (2026-11-17):
// - bulk confirm only takes the engine's suggestion or a card's ONLY product,
//   never "the first product" of an ambiguous card;
// - a single confirmation goes through confirm_market_variant_choice (teaches
//   the engine) and falls back to set_market_mapping_manual before the migration;
// - the candidate list shows the suggestion first, badged, with version numbers.
import assert from 'node:assert/strict';

const storage = new Map();
globalThis.localStorage = { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
globalThis.window = globalThis.window || { addEventListener: () => {}, FPT_CONFIG: undefined };
globalThis.document ??= { querySelector() { return null; }, querySelectorAll() { return []; } };

const { MarketWatchController, mapConfirmQueuePayload, bulkConfirmCandidate, mappingConfirmBlock } = await import('../js/market-watch.js');

const candidates = ids => ({ candidates: ids.map(productId => ({ productId, cardName: 'Cyberse Contract Witch', expansion: 'Magnificent Monsters', rarity: '' })) });
const payload = { items: [
  { printing_id: 'single', card_name: 'Una sola versione', resolver_status: 'PROVIDER_AGGREGATE', mapping_evidence: { providerProductId: '500', providerCardName: 'X', providerExpansion: 'Set' } },
  { printing_id: 'suggested', card_name: 'Cyberse Contract Witch', resolver_status: 'AMBIGUOUS', mapping_evidence: candidates(['904603', '904602', '904604']), suggested_product_id: '904602', suggestion_note: 'rarità base, versione più economica' },
  { printing_id: 'unknown', card_name: 'Senza indizi', resolver_status: 'AMBIGUOUS', mapping_evidence: candidates(['10', '11']) },
] };
const items = mapConfirmQueuePayload(payload);
assert.equal(items[1].suggestedProductId, '904602');
assert.equal(items[1].suggestionNote, 'rarità base, versione più economica');
assert.equal(bulkConfirmCandidate(items[0]).productId, '500', 'unico prodotto: confermabile in blocco');
assert.equal(bulkConfirmCandidate(items[1]).productId, '904602', 'carta ambigua: SOLO la versione suggerita, non la prima della lista');
assert.equal(bulkConfirmCandidate(items[2]), null, 'carta ambigua senza suggerimento: va scelta a mano');
console.log('PASS conferma in blocco: suggerimento o prodotto unico, mai "il primo" di una carta ambigua');

const html = mappingConfirmBlock(items[1]);
assert(html.indexOf('904602') < html.indexOf('904603'), 'la versione suggerita compare per prima');
assert.match(html, /mapping-confirm-row is-suggested/);
assert.match(html, /Suggerita<\/em>/);
assert.match(html, /Suggerita: <b>rarità base, versione più economica<\/b>/);
assert.match(html, /· V\.1<\/small>/); assert.match(html, /· V\.2<\/small>/);
assert(!/is-suggested/.test(mappingConfirmBlock(items[2])), 'nessun badge senza suggerimento');
console.log('PASS lista candidati: suggerita in cima con badge e motivo, numeri di versione V.n');

// Controller: bulk confirms 2 of 3, single confirmation uses the teaching RPC.
const calls = [], single = [];
let queueLoads = 0;
const api = {
  marketWatchExtra: async () => ({ items: [], deckUnresolved: [] }),
  marketWatchSummary: async () => ({ portfolioValue: { current: 0, complete: false }, confirmCount: 3, aggregatePendingCount: 3, catalogPriceFloor: {}, lastSync: null }),
  marketWatchOwnedPage: async () => ({ items: [], total: 0, limit: 60, offset: 0 }),
  marketConfirmQueue: async () => { queueLoads++; return payload; },
  setMarketMappingManual: async (printingId, productId) => { calls.push({ printingId, productId }); },
  confirmMarketVariantChoice: async (printingId, productId) => { single.push({ printingId, productId }); },
};
const toasts = [];
const controller = new MarketWatchController({ api, getGame: () => 'yugioh', getDecks: () => [], onRender: () => {}, onToast: message => toasts.push(message), onNavigate: () => {} });
await controller.load();
await controller.loadConfirmQueue();
assert.deepEqual(controller.suggestedQueue().map(item => item.printingId).sort(), ['single', 'suggested']);
await controller.confirmAllAggregate();
assert.deepEqual(calls.sort((a, b) => a.printingId.localeCompare(b.printingId)), [{ printingId: 'single', productId: '500' }, { printingId: 'suggested', productId: '904602' }]);
assert.match(toasts.at(-1), /Confermate 2 carte sulla versione suggerita/);
console.log('PASS controller: "Conferma i suggeriti" conferma 2 carte su 3 sulla versione giusta');

await controller.confirmMapping('unknown', '11', { productName: 'Senza indizi' });
assert.deepEqual(single, [{ printingId: 'unknown', productId: '11' }], 'la conferma singola passa dalla RPC che insegna al motore');
assert.equal(calls.length, 2, 'e non dalla conferma "muta" di prima');
console.log('PASS conferma singola: confirm_market_variant_choice');

// Empty suggestion queue → explicit message, no RPC.
payload.items = [payload.items[2]];
const before = calls.length;
await controller.loadConfirmQueue();
await controller.confirmAllAggregate();
assert.equal(calls.length, before);
assert.match(toasts.at(-1), /Nessun suggerimento pronto/);
console.log('PASS nessun suggerimento: messaggio chiaro, nessuna conferma alla cieca');
console.log('market-watch-suggested-confirm-smoke: OK');
