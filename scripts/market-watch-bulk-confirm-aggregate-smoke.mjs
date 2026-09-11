import assert from 'node:assert/strict';

const storage = new Map();
globalThis.localStorage = { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
globalThis.window = globalThis.window || { addEventListener: () => {}, FPT_CONFIG: undefined };
// refreshAfterLoad()/refreshBoardSection() cercano una sezione montata nel DOM
// reale per aggiornarsi sul posto — qui nessuna è mai montata, quindi devono
// ricadere su onRender() come se il componente non fosse a schermo.
globalThis.document ??= { querySelector() { return null; }, querySelectorAll() { return []; } };

const { MarketWatchController } = await import('../js/market-watch.js');

function aggregateRow(id, productId) {
  return {
    printing_id: id, card_name: `Carta ${id}`, mapping_status: 'resolved', resolver_status: 'PROVIDER_AGGREGATE',
    mapping_evidence: { providerProductId: productId, providerCardName: `Carta ${id}`, providerExpansion: 'Set Demo', providerRarity: '' }
  };
}

// 2026-09-11: list_market_watch (payload unico, tutte le printing) sostituita
// da RPC mirate — vedi supabase/migrations/20260911145101_market_watch_owned_pagination.sql.
// list_market_confirm_queue è l'UNICA che porta mapping_evidence, e per
// costruzione contiene solo le printing che hanno davvero bisogno di
// conferma: p1/p2/p3 (PROVIDER_AGGREGATE con un candidato risolto) e p6
// (rarità non corrispondente, AMBIGUOUS). p4 (EXACT) e p5 (già manual) non
// compaiono affatto nel payload — il vecchio list_market_watch li portava
// comunque e il filtro avveniva lato client su this.data.items.
const confirmQueuePayload = {
  items: [
    aggregateRow('p1', '111'),
    aggregateRow('p2', '112'),
    aggregateRow('p3', '113'),
    { printing_id: 'p6', card_name: 'Carta rarità ambigua', mapping_status: 'resolved', resolver_status: 'UNRESOLVED', mapping_reason: 'provider_rarity_mismatch', mapping_evidence: { candidates: [{ productId: '900', cardName: 'Carta rarità ambigua', expansion: 'Set Demo', rarity: 'Ultra Rare' }, { productId: '901', cardName: 'Carta rarità ambigua', expansion: 'Set Demo', rarity: 'Secret Rare' }] } }
  ]
};

const calls = [];
let ownedPageCalls = 0, confirmQueueCalls = 0;
const api = {
  marketWatchExtra: async () => ({ items: [], deckUnresolved: [] }),
  marketWatchSummary: async () => ({ portfolioValue: { current: 0, complete: false }, confirmCount: 4, aggregatePendingCount: 3, catalogPriceFloor: {}, lastSync: null }),
  marketWatchOwnedPage: async () => { ownedPageCalls++; return { items: [], total: 0, limit: 60, offset: 0 }; },
  marketConfirmQueue: async () => { confirmQueueCalls++; return confirmQueuePayload; },
  setMarketMappingManual: async (printingId, productId, meta) => { calls.push({ printingId, productId, meta }); if (printingId === 'p2') throw new Error('boom'); }
};

const controller = new MarketWatchController({ api, getGame: () => 'yugioh', getDecks: () => [], onRender: () => {}, onToast: () => {}, onNavigate: () => {} });
await controller.load();
assert.equal(ownedPageCalls, 1, 'load iniziale (una sola richiesta di pagina Raccolta)');
assert.equal(confirmQueueCalls, 0, 'la coda di conferma non va richiesta finché nessuno apre quella tab (mapping_evidence resta fuori dal payload generale)');
assert.deepEqual(controller.aggregatePendingQueue(), [], 'confirmQueue è vuota finché non viene caricata lazy');

await controller.loadConfirmQueue();
assert.equal(confirmQueueCalls, 1);
assert.deepEqual(controller.rarityMismatchQueue().map(item => item.printingId), ['p6'], 'rarità ambigua non confusa con la coda aggregate');
const pending = controller.aggregatePendingQueue();
assert.deepEqual(pending.map(item => item.printingId).sort(), ['p1', 'p2', 'p3'], 'solo le printing PROVIDER_AGGREGATE con un candidato risolto entrano in coda, non la rarità-ambigua (quella resta alla scelta manuale in "Conferma rarità")');

await controller.confirmAllAggregate();

assert.equal(calls.length, 3, 'una chiamata RPC per ogni carta aggregate in coda');
assert.deepEqual(calls.map(c => c.printingId).sort(), ['p1', 'p2', 'p3']);
const p1Call = calls.find(c => c.printingId === 'p1');
assert.equal(p1Call.productId, '111', 'usa il productId già risolto dal resolver, non ne inventa uno nuovo');
assert.equal(p1Call.meta.expansion, 'Set Demo');

assert.equal(ownedPageCalls, 2, 'un solo reload della pagina Raccolta a fine batch, non uno per ogni carta confermata');
assert.equal(confirmQueueCalls, 2, 'confirmAllAggregate ricarica anche la coda di conferma a fine batch (le carte appena confermate non devono restarci)');
assert.equal(controller.bulkConfirmBusy, false, 'lo stato di busy si resetta a fine batch anche se una chiamata fallisce');
assert.equal(controller.bulkConfirmProgress, null);

// test-the-test: un fallimento isolato (p2) non deve bloccare le altre due conferme né il reload finale
assert.equal(calls.filter(c => c.printingId !== 'p2').length, 2, 'i fallimenti di una carta non impediscono le altre');

console.log('PASS coda aggregate esclude EXACT/manual/rarità-ambigua, conferma bulk unica RPC per carta + singolo reload di pagina+coda, resiliente ai fallimenti parziali');
