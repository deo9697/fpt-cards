// P0 — Raccolta: il dettaglio carta mostrava "Prezzo non disponibile" per
// printing che HANNO un prezzo reale, perché il lookup cercava SOLO dentro
// marketWatch.allLoadedItems() (paginato server-side, ~60 printing iniziali)
// invece di fare un fetch mirato per la printing aperta. Copre:
// MarketWatchController.ensureItemPrice/priceCacheEntry (js/market-watch.js)
// e collectionDetailView's priceState (js/collection.js) — vedi
// supabase/migrations/20260917140000_market_watch_single_printing_price.sql
// per la RPC lato server (get_market_watch_item_price, stessa catena
// preferred/reference di list_market_watch_owned_page, nessuna nuova logica
// di prezzo).
import assert from 'node:assert/strict';

const storage = new Map();
globalThis.localStorage = { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
globalThis.window = globalThis.window || { addEventListener: () => {}, FPT_CONFIG: undefined };
globalThis.document ??= { querySelector() { return null; }, querySelectorAll() { return []; } };

const { MarketWatchController } = await import('../js/market-watch.js');
const { collectionDetailView } = await import('../js/collection.js');

function test(name, fn) { try { fn(); console.log(`PASS ${name}`); } catch (err) { console.error(`FAIL ${name}`); console.error(err); process.exitCode = 1; } }
async function asyncTest(name, fn) { try { await fn(); console.log(`PASS ${name}`); } catch (err) { console.error(`FAIL ${name}`); console.error(err); process.exitCode = 1; } }

function deferred() { let resolve, reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; }

function makeController({ itemPriceImpl } = {}) {
  let renders = 0;
  const api = {
    marketWatchOwnedPage: async () => ({ items: [], total: 0, limit: 60, offset: 0 }),
    marketWatchExtra: async () => ({ items: [], deckUnresolved: [] }),
    marketWatchSummary: async () => ({ portfolioValue: { current: 0, complete: false }, confirmCount: 0, aggregatePendingCount: 0, catalogPriceFloor: {}, lastSync: null }),
    marketWatchItemPrice: itemPriceImpl || (async () => ({ referencePrice: null, capturedAt: null }))
  };
  const controller = new MarketWatchController({ api, getGame: () => 'yugioh', getDecks: () => [], onRender: () => { renders++; }, onToast: () => {}, onNavigate: () => {} });
  return { controller, api, renderCount: () => renders };
}

// 1) prezzo già presente nella cache Market Watch (findItem) -> nessun fetch, subito 'ready'.
await asyncTest('già presente in allLoadedItems (findItem) -> subito ready, nessuna RPC', async () => {
  let calls = 0;
  const { controller } = makeController({ itemPriceImpl: async () => { calls++; return { referencePrice: 1 }; } });
  controller.ownedPage.items = [{ printingId: 'p1', referencePrice: 12.5, latestAt: '2026-09-17T00:00:00Z' }];
  controller.ensureItemPrice('p1');
  assert.equal(calls, 0, 'findItem già soddisfa il prezzo: nessuna RPC di rete deve partire');
  assert.deepEqual(controller.priceCacheEntry('p1'), { status: 'ready', price: 12.5, capturedAt: '2026-09-17T00:00:00Z' });
});

// 2) prezzo non presente nella pagina Market Watch ma presente nel DB -> fetch mirato, 'ready' col prezzo reale.
// onSettled è un callback PER CHIAMATA (mai this.onRender, vedi commento su
// ensureItemPrice in js/market-watch.js: renderRoute() rimuoverebbe il
// .detail-backdrop del dettaglio senza riprodurlo — bug reale scoperto con
// questo stesso fix, catturato da auth-regression-smoke.mjs).
await asyncTest('non in allLoadedItems ma presente nel DB -> fetch mirato, diventa ready, callback per-chiamata (mai onRender)', async () => {
  let calls = 0;
  const { controller, renderCount } = makeController({ itemPriceImpl: async id => { calls++; assert.equal(id, 'p2'); return { referencePrice: 7.3, capturedAt: '2026-09-17T10:00:00Z' }; } });
  let settledWith = null;
  controller.ensureItemPrice('p2', id => { settledWith = id; });
  assert.deepEqual(controller.priceCacheEntry('p2'), { status: 'loading', price: null, capturedAt: null }, 'subito dopo la chiamata, sincrono: loading');
  await new Promise(r => setTimeout(r, 0));
  assert.equal(calls, 1);
  assert.deepEqual(controller.priceCacheEntry('p2'), { status: 'ready', price: 7.3, capturedAt: '2026-09-17T10:00:00Z' });
  assert.equal(settledWith, 'p2', 'onSettled(printingId) chiamato con la printing corretta a fetch completato');
  assert.equal(renderCount(), 0, 'nessun render/renderRoute globale — solo il callback per-chiamata, mai this.onRender()');
});

// 3) printing realmente senza prezzo -> backend risponde referencePrice:null -> 'missing', MAI 'ready'.
await asyncTest('printing realmente senza prezzo -> missing (mai una fantomatica ready)', async () => {
  const { controller } = makeController({ itemPriceImpl: async () => ({ referencePrice: null, capturedAt: null }) });
  controller.ensureItemPrice('p3');
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(controller.priceCacheEntry('p3'), { status: 'missing', price: null, capturedAt: null });
});

// 4) richiesta fallita -> 'error', mai bloccata per sempre come 'missing' silenzioso.
await asyncTest('richiesta fallita -> error (distinto da missing)', async () => {
  const { controller } = makeController({ itemPriceImpl: async () => { throw new Error('rete assente'); } });
  controller.ensureItemPrice('p4');
  await new Promise(r => setTimeout(r, 0));
  assert.equal(controller.priceCacheEntry('p4').status, 'error');
});

// 5) chiusura dettaglio mentre la richiesta è ancora in corso -> nessun crash, il fetch si completa comunque in background.
await asyncTest('richiesta ancora in corso alla "chiusura" (nessun listener) -> si completa senza errori', async () => {
  const gate = deferred();
  const { controller } = makeController({ itemPriceImpl: async () => gate.promise });
  controller.ensureItemPrice('p5');
  assert.equal(controller.priceCacheEntry('p5').status, 'loading');
  // "Chiusura del dettaglio" non ha alcun effetto sul controller (nessun
  // riferimento da ripulire, nessun timer) — il fetch prosegue e basta.
  gate.resolve({ referencePrice: 3, capturedAt: null });
  await new Promise(r => setTimeout(r, 0));
  assert.equal(controller.priceCacheEntry('p5').status, 'ready', 'il fetch completa comunque, anche se il dettaglio non è più aperto');
});

// 6) riapertura stessa carta -> nessuna seconda fetch (né mentre 'loading' né dopo 'ready'/'missing').
await asyncTest('riapertura della stessa carta: nessuna seconda RPC (loading, poi ready)', async () => {
  let calls = 0;
  const gate = deferred();
  const { controller } = makeController({ itemPriceImpl: async () => { calls++; return gate.promise; } });
  controller.ensureItemPrice('p6'); // 1a apertura -> parte il fetch
  controller.ensureItemPrice('p6'); // "riapertura" mentre è ancora in corso -> nessuna seconda RPC
  assert.equal(calls, 1);
  gate.resolve({ referencePrice: 9 });
  await new Promise(r => setTimeout(r, 0));
  controller.ensureItemPrice('p6'); // riapertura dopo il successo -> ancora nessuna nuova RPC
  assert.equal(calls, 1, 'una volta ready, riaprire la stessa carta non deve rifare la richiesta');
});
await asyncTest('riapertura dopo missing: nessuna seconda RPC (missing non è un errore transitorio)', async () => {
  let calls = 0;
  const { controller } = makeController({ itemPriceImpl: async () => { calls++; return { referencePrice: null }; } });
  controller.ensureItemPrice('p6b');
  await new Promise(r => setTimeout(r, 0));
  controller.ensureItemPrice('p6b');
  assert.equal(calls, 1);
});
await asyncTest('dopo un errore, la riapertura successiva PUÒ ritentare (error non blocca un retry)', async () => {
  let calls = 0;
  const { controller } = makeController({ itemPriceImpl: async () => { calls++; if (calls === 1) throw new Error('boom'); return { referencePrice: 4 }; } });
  controller.ensureItemPrice('p6c');
  await new Promise(r => setTimeout(r, 0));
  assert.equal(controller.priceCacheEntry('p6c').status, 'error');
  controller.ensureItemPrice('p6c');
  await new Promise(r => setTimeout(r, 0));
  assert.equal(calls, 2, 'un fallimento non deve bloccare per sempre un futuro tentativo');
  assert.equal(controller.priceCacheEntry('p6c').status, 'ready');
});

// 7) apertura rapida carta A -> carta B con risposta tardiva di A: la
// risposta di A non deve finire sul dettaglio B (cache per-printingId
// indipendente, mai uno stato "corrente" condiviso tra le due richieste).
await asyncTest('apertura rapida A poi B: la risposta tardiva di A resta sotto A, mai sotto B', async () => {
  const gateA = deferred();
  const { controller } = makeController({
    itemPriceImpl: async id => (id === 'A' ? gateA.promise : { referencePrice: 20, capturedAt: 'B-time' })
  });
  controller.ensureItemPrice('A'); // parte, resta pending
  controller.ensureItemPrice('B'); // apertura rapida della carta successiva
  await new Promise(r => setTimeout(r, 0));
  assert.equal(controller.priceCacheEntry('B').status, 'ready', 'B deve risolversi normalmente anche con A ancora pendente');
  assert.equal(controller.priceCacheEntry('B').price, 20);
  assert.equal(controller.priceCacheEntry('A').status, 'loading', 'A è ancora pendente, non deve mai mostrare il prezzo di B');
  gateA.resolve({ referencePrice: 5, capturedAt: 'A-time' }); // risposta tardiva di A
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(controller.priceCacheEntry('A'), { status: 'ready', price: 5, capturedAt: 'A-time' }, 'A risolve col PROPRIO prezzo, mai contaminato da B');
  assert.deepEqual(controller.priceCacheEntry('B'), { status: 'ready', price: 20, capturedAt: 'B-time' }, 'B resta invariata dalla risoluzione tardiva di A');
});

// --- collectionDetailView: priceState (rendering) -----------------------
const baseCard = { id: 'mine-1', printingId: 'printing-1', game: 'yugioh', cardName: 'Dark Magician', quantityOwned: 1, quantityLoaned: 0, quantityReserved: 0, quantityAvailable: 1 };

test('priceState ready -> importo formattato, mai "Prezzo non disponibile"', () => {
  const html = collectionDetailView('mine-1', 'mine', { mine: [baseCard], team: [] }, true, 'me', [], '', true, { status: 'ready', price: 12.5 });
  assert(html.includes('12,50') || html.includes('12,5'), 'prezzo non mostrato correttamente');
  assert.equal(html.includes('Prezzo non disponibile'), false);
  assert.equal(html.includes('Caricamento prezzo'), false);
});
test('priceState loading -> "Caricamento prezzo…", MAI "Prezzo non disponibile"', () => {
  const html = collectionDetailView('mine-1', 'mine', { mine: [baseCard], team: [] }, true, 'me', [], '', true, { status: 'loading', price: null });
  assert(html.includes('Caricamento prezzo'), 'stato intermedio mancante durante il fetch');
  assert.equal(html.includes('Prezzo non disponibile'), false, 'non deve mai mostrare "non disponibile" mentre la richiesta è ancora in corso');
});
test('priceState missing -> "Prezzo non disponibile" SOLO quando il backend ha confermato l\'assenza', () => {
  const html = collectionDetailView('mine-1', 'mine', { mine: [baseCard], team: [] }, true, 'me', [], '', true, { status: 'missing', price: null });
  assert(html.includes('Prezzo non disponibile'));
});
test('priceState assente (retro-compatibilità): stesso comportamento di prima, basato solo su marketItems', () => {
  const withArray = collectionDetailView('mine-1', 'mine', { mine: [baseCard], team: [] }, true, 'me', [{ printingId: 'printing-1', referencePrice: 3.4 }], '', true);
  assert(withArray.includes('3,40') || withArray.includes('3,4'));
  const withoutMatch = collectionDetailView('mine-1', 'mine', { mine: [baseCard], team: [] }, true, 'me', [], '', true);
  assert(withoutMatch.includes('Prezzo non disponibile'), 'senza priceState e senza match in marketItems, comportamento invariato');
});

// --- Guardia di regressione: il fetch del prezzo NON deve mai innescare un
// render globale (renderRoute()/render()) — è esattamente il bug reale
// scoperto integrando questo fix: renderRoute() sostituisce SOLO .page-stage
// e rimuove ogni .detail-backdrop esistente SENZA riprodurlo (il dettaglio
// Raccolta vive fuori da .page-stage), quindi un onRender() generico alla
// risoluzione del prezzo faceva sparire silenziosamente il dettaglio appena
// aperto non appena il fetch completava. Catturato da auth-regression-
// smoke.mjs ("Disponibilità proprietario assente nel dettaglio team").
{
  const fs = await import('node:fs');
  const appSource = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  test('app.js: il fetch prezzo aggiorna il DOM in modo mirato (updateDetailPriceBox), mai via renderRoute()/render() generico', () => {
    assert.match(appSource, /marketWatch\.ensureItemPrice\(printingId, \(\) => \{ if \(selectedCollectionItem === id\) updateDetailPriceBox\(id\); \}\)/);
    assert.match(appSource, /function updateDetailPriceBox\(id\) \{/);
    assert.match(appSource, /document\.querySelector\('\.inventory-detail \[data-inventory-market-summary\]'\)/);
  });
}

console.log('PASS Raccolta — lookup prezzo lazy/mirato: già-in-cache/fetch-mirato/senza-prezzo/errore/chiusura-in-corso/riapertura-senza-refetch/nessuna-contaminazione-tra-carte, rendering loading/ready/missing coerente, retro-compatibilità preservata, aggiornamento DOM mirato (mai un render globale)');
