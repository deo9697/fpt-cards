// Market Watch (2026-11-18): the admin's confirmation queue covers the whole
// team. Each row says who owns the card; "Solo le mie" filters to own cards;
// the tab appears even when the admin's personal summary count is 0.
import assert from 'node:assert/strict';

const storage = new Map();
globalThis.localStorage = { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
globalThis.window = globalThis.window || { addEventListener: () => {}, FPT_CONFIG: undefined };
globalThis.document ??= { querySelector() { return null; }, querySelectorAll() { return []; } };

const { MarketWatchController, mapConfirmQueuePayload } = await import('../js/market-watch.js');

const evidence = { candidates: [{ productId: '1', expansion: 'Set' }, { productId: '2', expansion: 'Set' }] };
const payload = { items: [
  { printing_id: 'a', card_name: 'Carta di Nello', resolver_status: 'AMBIGUOUS', mapping_evidence: evidence, owners: ['Nello'], mine: false },
  { printing_id: 'b', card_name: 'Carta condivisa', resolver_status: 'AMBIGUOUS', mapping_evidence: evidence, owners: ['Daniele', 'Nello', 'Simona', 'Marco'], mine: true },
] };
const items = mapConfirmQueuePayload(payload);
assert.deepEqual(items.map(item => item.mine), [false, true]);
assert.equal(mapConfirmQueuePayload({ items: [{ printing_id: 'x' }] })[0].mine, true, 'payload vecchio (senza mine): tutte mie');

let loads = 0;
const api = {
  marketWatchExtra: async () => ({ items: [], deckUnresolved: [] }),
  marketWatchSummary: async () => ({ portfolioValue: { current: 0, complete: false }, confirmCount: 0, aggregatePendingCount: 0, catalogPriceFloor: {}, lastSync: null }),
  marketWatchOwnedPage: async () => ({ items: [], total: 0, limit: 60, offset: 0 }),
  marketConfirmQueue: async () => { loads++; return payload; },
};
const controller = new MarketWatchController({ api, getGame: () => 'yugioh', getDecks: () => [], isAdmin: () => true, onRender: () => {}, onToast: () => {}, onNavigate: () => {} });
await controller.load();
for (let i = 0; i < 20 && !controller.confirmQueueLoaded; i++) await new Promise(resolve => setTimeout(resolve, 5));
assert.equal(loads, 1, "l'admin carica la coda del team subito dopo il riepilogo");
const board = () => controller.renderBoardSection({ items: [], marketDecks: [], hasSnapshots: false, confirmQueue: controller.rarityMismatchQueue(), aggregatePending: [], anomalyQueue: [] });
assert.match(board(), /data-market-tab="confirm"/, 'scheda visibile anche con 0 carte proprie nel riepilogo');
assert.equal(controller.rarityMismatchQueue().length, 2, 'Tutto il team: entrambe');
const rows = controller.confirmRows(controller.rarityMismatchQueue());
assert.match(rows, /Tutto il team <span>2<\/span>/);
assert.match(rows, /Solo le mie <span>1<\/span>/);
assert(rows.includes('Daniele, Nello, Simona e altri 1'), 'proprietari mostrati, abbreviati oltre 3');
controller.confirmScope = 'mine';
assert.deepEqual(controller.rarityMismatchQueue().map(item => item.printingId), ['b'], 'Solo le mie');
console.log('PASS coda conferme: tutto il team con i proprietari, filtro "Solo le mie", scheda visibile per l\'admin');

const user = new MarketWatchController({ api, getGame: () => 'yugioh', getDecks: () => [], isAdmin: () => false, onRender: () => {}, onToast: () => {}, onNavigate: () => {} });
loads = 0; await user.load(); await new Promise(resolve => setTimeout(resolve, 30));
assert.equal(loads, 0, 'chi non è admin non carica la coda');
console.log('PASS non admin: nessuna coda');
console.log('market-watch-team-confirm-smoke: OK');
