import assert from 'node:assert/strict';

const storage = new Map();
globalThis.localStorage = { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
globalThis.window = globalThis.window || { addEventListener: () => {} };

const { MarketWatchController, mapPayload } = await import('../js/market-watch.js');

function aggregateRow(id, productId) {
  return {
    printing_id: id, card_name: `Carta ${id}`, sources: ['owned'], owned_quantity: 1,
    reference_price: 5, mapping_status: 'resolved', resolver_status: 'PROVIDER_AGGREGATE',
    mapping_evidence: { providerProductId: productId, providerCardName: `Carta ${id}`, providerExpansion: 'Set Demo', providerRarity: '' }
  };
}

const payload = {
  items: [
    aggregateRow('p1', '111'),
    aggregateRow('p2', '112'),
    aggregateRow('p3', '113'),
    { printing_id: 'p4', card_name: 'Carta esatta', sources: ['owned'], owned_quantity: 1, reference_price: 9, mapping_status: 'resolved', resolver_status: 'EXACT' },
    { printing_id: 'p5', card_name: 'Carta già confermata', sources: ['owned'], owned_quantity: 1, reference_price: 9, mapping_status: 'manual', resolver_status: 'manual' },
    { printing_id: 'p6', card_name: 'Carta rarità ambigua', sources: ['owned'], owned_quantity: 1, reference_price: 9, mapping_status: 'resolved', resolver_status: 'UNRESOLVED', mapping_reason: 'provider_rarity_mismatch', mapping_evidence: { candidates: [{ productId: '900', cardName: 'Carta rarità ambigua', expansion: 'Set Demo', rarity: 'Ultra Rare' }, { productId: '901', cardName: 'Carta rarità ambigua', expansion: 'Set Demo', rarity: 'Secret Rare' }] } }
  ]
};

const calls = [];
let loadCount = 0;
const api = {
  marketWatch: async () => { loadCount++; return payload; },
  marketDashboardMovers: async () => [],
  marketPriceHistory: async () => [],
  setMarketMappingManual: async (printingId, productId, meta) => { calls.push({ printingId, productId, meta }); if (printingId === 'p2') throw new Error('boom'); }
};

const controller = new MarketWatchController({ api, getGame: () => 'yugioh', getDecks: () => [], onRender: () => {}, onToast: () => {}, onNavigate: () => {} });
await controller.load();
assert.equal(loadCount, 1, 'load iniziale');

const pending = controller.aggregatePendingQueue();
assert.deepEqual(pending.map(item => item.printingId).sort(), ['p1', 'p2', 'p3'], 'solo le printing PROVIDER_AGGREGATE con un candidato risolto entrano in coda, non EXACT, già manual, o rarità-ambigua con più candidati reali (quella resta alla scelta manuale in "Conferma rarità")');

await controller.confirmAllAggregate();

assert.equal(calls.length, 3, 'una chiamata RPC per ogni carta aggregate in coda');
assert.deepEqual(calls.map(c => c.printingId).sort(), ['p1', 'p2', 'p3']);
const p1Call = calls.find(c => c.printingId === 'p1');
assert.equal(p1Call.productId, '111', 'usa il productId già risolto dal resolver, non ne inventa uno nuovo');
assert.equal(p1Call.meta.expansion, 'Set Demo');

assert.equal(loadCount, 2, 'un solo reload alla fine del batch, non uno per ogni carta confermata');
assert.equal(controller.bulkConfirmBusy, false, 'lo stato di busy si resetta a fine batch anche se una chiamata fallisce');
assert.equal(controller.bulkConfirmProgress, null);

// test-the-test: un fallimento isolato (p2) non deve bloccare le altre due conferme né il reload finale
assert.equal(calls.filter(c => c.printingId !== 'p2').length, 2, 'i fallimenti di una carta non impediscono le altre');

console.log('PASS coda aggregate esclude EXACT/manual, conferma bulk unica RPC per carta + singolo reload, resiliente ai fallimenti parziali');
