// Dashboard Market Watch: Top 3 Up / Top 3 Down — logica pura (positiveMovers/
// negativeMovers, già esistenti/simmetrici in js/market-watch.js) + markup
// HTML di dashboardView(), nessun browser/canvas reale necessario qui. Il
// comportamento reale nel browser (artwork cropped, righe cliccabili, niente
// più carousel) resta coperto da scripts/market-watch-browser-smoke.mjs.
import assert from 'node:assert/strict';
globalThis.window ??= { addEventListener: () => {}, FPT_CONFIG: undefined };
globalThis.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const { positiveMovers, negativeMovers } = await import('../js/market-watch.js');
const { dashboardView } = await import('../js/dashboard.js');

function item(overrides) {
  return { printingId: 'p', catalogCardId: 'c', cardName: 'Card', imageUrl: '', ownedQuantity: 1, sources: ['owned'], referencePrice: 10, price24h: 10, ...overrides };
}
const state = { currentUser: 'daniele', loans: [] };

// --- negativeMovers: simmetrico a positiveMovers, mai una nuova RPC -------
{
  const items = [
    item({ printingId: 'a', catalogCardId: 'a', cardName: 'Drop grande', referencePrice: 5, price24h: 10 }),  // -50%
    item({ printingId: 'b', catalogCardId: 'b', cardName: 'Drop piccolo', referencePrice: 9, price24h: 10 }),  // -10%
    item({ printingId: 'c', catalogCardId: 'c', cardName: 'Stabile', referencePrice: 10, price24h: 10 }),      // 0%, escluso
    item({ printingId: 'd', catalogCardId: 'd', cardName: 'Su', referencePrice: 12, price24h: 10 }),           // +20%, escluso da negativeMovers
    item({ printingId: 'e', catalogCardId: 'e', cardName: 'Non owned', sources: [], referencePrice: 3, price24h: 10 }) // escluso, non owned
  ];
  const down = negativeMovers(items, 3);
  assert.deepEqual(down.map(row => row.catalogCardId), ['a', 'b'], 'ordine per calo più grande prima, esclusi 0%/positivi/non-owned');
  assert(down[0].positiveChange < 0 && down[1].positiveChange < 0, 'positiveChange deve restare negativo per un calo (stesso campo usato dalle righe Up, mai un nome diverso)');
  assert.equal(down[0].positiveChange, -50, 'percentuale di calo calcolata correttamente');
  console.log('PASS negativeMovers: simmetrico a positiveMovers, ordina per calo maggiore, esclude 0%/positivi/non-owned, mai una nuova RPC');
}

// --- Limite a 3 e dedup per carta logica -----------------------------------
{
  const items = Array.from({ length: 6 }, (_, i) => item({ printingId: `p${i}`, catalogCardId: `c${i}`, cardName: `Carta ${i}`, referencePrice: 10 - i, price24h: 10 }));
  const dup = item({ printingId: 'dup2', catalogCardId: 'c0', cardName: 'Carta 0 (altra printing)', referencePrice: 4, price24h: 10 });
  const down = negativeMovers([...items, dup], 3);
  assert.equal(down.length, 3, 'mai più di "limit" righe');
  assert.equal(new Set(down.map(row => row.catalogCardId)).size, 3, 'nessun duplicato per la stessa carta logica anche con printing diverse');
  console.log('PASS negativeMovers: limite a 3 righe, dedup per carta logica (catalogCardId) come positiveMovers');
}

// --- dashboardView: due liste leggibili, mai un carousel -------------------
{
  const items = [
    item({ printingId: 'up1', catalogCardId: 'u1', cardName: 'Su Uno', imageUrl: 'https://images.ygoprodeck.com/images/cards/1.jpg', referencePrice: 12, price24h: 10 }),
    item({ printingId: 'down1', catalogCardId: 'd1', cardName: 'Giù Uno', imageUrl: '', referencePrice: 5, price24h: 10 })
  ];
  const html = dashboardView(state, 'yugioh', { items });
  assert(html.includes('market-movers-lists'), 'deve usare il nuovo layout a due liste');
  assert(!html.includes('market-mover-slide') && !html.includes('market-movers-carousel'), 'il vecchio carousel non deve più comparire');
  assert(html.includes('In salita') && html.includes('In discesa'), 'entrambe le etichette delle due classifiche devono comparire');
  assert(html.includes('Su Uno') && html.includes('Giù Uno'), 'entrambe le carte devono comparire nella rispettiva lista');
  console.log('PASS dashboardView: due liste leggibili (In salita/In discesa), niente più carousel');
}

// --- Edge case: meno di 3 movers, un solo mover per direzione --------------
{
  const items = [item({ printingId: 'up1', catalogCardId: 'u1', cardName: 'Unica su', referencePrice: 11, price24h: 10 })];
  const html = dashboardView(state, 'yugioh', { items });
  assert(html.includes('Unica su'), 'l\'unico mover in salita deve comparire');
  assert(html.includes('Nessuna variazione negativa'), 'con zero movers in discesa deve mostrare un messaggio neutro per quella sola lista, non nascondere l\'intero pannello');
  assert(html.includes('market-movers-lists'), 'il pannello resta comunque il layout a due liste (una sola riga presente, non un fallback diverso)');
  console.log('PASS edge case: meno di 3 movers per direzione, messaggio neutro solo per la lista vuota');
}

// --- Edge case: nessuna variazione in nessuna direzione (pannello vuoto) ---
{
  const items = [item({ printingId: 'flat1', catalogCardId: 'f1', cardName: 'Stabile', referencePrice: 10, price24h: 10 })];
  const html = dashboardView(state, 'yugioh', { items });
  assert(html.includes('featured-empty'), 'con zero movers in entrambe le direzioni deve tornare lo stato vuoto dell\'intero pannello');
  assert(html.includes('Trend in preparazione'), 'messaggio di stato vuoto atteso');
  assert(!html.includes('market-movers-lists'), 'lo stato vuoto non deve montare il layout a due liste');
  console.log('PASS edge case: nessuna variazione in nessuna direzione, stato vuoto dell\'intero pannello');
}

// --- Edge case: artwork assente -> placeholder, mai un <img> rotto ---------
{
  const items = [item({ printingId: 'noart', catalogCardId: 'n1', cardName: 'Senza artwork', imageUrl: '', referencePrice: 5, price24h: 10 })];
  const html = dashboardView(state, 'yugioh', { items });
  assert(html.includes('market-mover-row-art-placeholder'), 'senza imageUrl deve comparire il placeholder, mai un <img src=""> rotto');
  console.log('PASS edge case: artwork assente, placeholder mostrato invece di un\'immagine rotta');
}

// --- Edge case: "prezzo precedente -> prezzo corrente" opzionale ----------
// Quando i movers in salita arrivano dalla RPC list_market_dashboard_movers
// (mapDashboardMovers), la forma NON include price24h (solo referencePrice/
// baselinePrice/positiveChange) — la riga deve restare valida, mostrando
// solo il prezzo corrente, senza mai un "undefined" o un crash.
{
  const { mapDashboardMovers } = await import('../js/market-watch.js');
  const rpcShaped = mapDashboardMovers([{ printingId: 'rpc1', catalogCardId: 'rpc1', cardName: 'Dalla RPC', referencePrice: 9, positiveChange: 12.5 }]);
  const html = dashboardView(state, 'yugioh', { items: [], featuredMovers: rpcShaped });
  assert(html.includes('Dalla RPC'), 'un mover proveniente dalla RPC (senza price24h) deve comunque comparire');
  assert(!html.includes('undefined'), 'un campo mancante (price24h) non deve mai finire come testo "undefined" nel markup');
  assert(!html.includes('market-mover-row-history'), 'senza price24h la riga "prezzo precedente → prezzo corrente" è opzionale e va omessa, mai un valore rotto');

  const withHistory = item({ printingId: 'h1', catalogCardId: 'hh1', cardName: 'Con storico', referencePrice: 8, price24h: 10 });
  const htmlWithHistory = dashboardView(state, 'yugioh', { items: [withHistory] });
  assert(htmlWithHistory.includes('market-mover-row-history'), 'quando price24h è disponibile (fallback client-side) deve mostrare "prezzo precedente → prezzo corrente"');
  console.log('PASS "prezzo precedente → prezzo corrente": opzionale, mostrato quando disponibile, mai un valore rotto quando la RPC non lo fornisce');
}

console.log('PASS dashboard movers (logica pura): negativeMovers simmetrico a positiveMovers, due liste leggibili, tutti gli edge case richiesti (meno di 3, nessuna variazione negativa, storico assente, artwork assente)');
