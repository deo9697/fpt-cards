// Dashboard Market Watch: hero carousel (solo artwork, carte in salita) con
// un grafico dell'andamento prezzo per slide — logica pura (positiveMovers
// già esistente in js/market-watch.js, invariata) + markup HTML di
// dashboardView(). Le liste Top 3 Up/Down sotto il carousel sono state
// rimosse su richiesta esplicita (non necessarie). Il comportamento reale
// nel browser (artwork cropped, navigazione carousel, sfondo "La tua
// collezione vale" della pagina Market Watch mai più oscurato) resta
// coperto da scripts/market-watch-browser-smoke.mjs e
// scripts/dashboard-trends-browser-smoke.mjs.
//
// Nota: un fix precedente aveva introdotto per errore una collisione di
// nomi CSS (.market-hero-art riusato sia per l'artwork del carousel sia,
// già da prima, per lo sfondo della testata Market Watch) che faceva
// sparire quello sfondo. Le classi di questo carousel usano ora il
// prefisso dedicato .market-featured-*, mai .market-hero-*.
import assert from 'node:assert/strict';
globalThis.window ??= { addEventListener: () => {}, FPT_CONFIG: undefined };
globalThis.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const { positiveMovers, negativeMovers } = await import('../js/market-watch.js');
const { dashboardView } = await import('../js/dashboard.js');

function item(overrides) {
  return { printingId: 'p', catalogCardId: 'c', cardName: 'Card', imageUrl: '', ownedQuantity: 1, sources: ['owned'], referencePrice: 10, price24h: 10, ...overrides };
}
const state = { currentUser: 'daniele', loans: [] };

// --- negativeMovers: rimane una funzione valida e testata, anche se non più
// consumata dalla Dashboard (rimossa la lista "In discesa" su richiesta) ---
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
  assert.equal(down[0].positiveChange, -50, 'percentuale di calo calcolata correttamente');
  console.log('PASS negativeMovers: ordina per calo maggiore, esclude 0%/positivi/non-owned (funzione riusabile, non più mostrata in Dashboard su richiesta)');
}

// --- dashboardView: solo hero carousel, niente più liste sotto -----------
{
  const items = [item({ printingId: 'up1', catalogCardId: 'u1', cardName: 'Su Uno', imageUrl: 'https://images.ygoprodeck.com/images/cards/1.jpg', referencePrice: 12, price24h: 10 })];
  const html = dashboardView(state, 'yugioh', { items });
  assert(html.includes('market-featured-carousel'), 'deve montare l\'hero carousel');
  assert(html.includes('Su Uno'), 'la carta in salita deve comparire come slide');
  assert(!html.includes('market-movers-lists') && !html.includes('market-mover-row') && !html.includes('In discesa'), 'le liste Up/Down sotto il carousel non devono più esistere');
  assert(!html.includes('market-hero-art') && !html.includes('data-hero-'), 'niente collisione di nomi con la testata della pagina Market Watch (.market-hero-*)');
  console.log('PASS dashboardView: solo hero carousel, nessuna lista Up/Down, nessuna collisione di classi con la testata Market Watch');
}

// --- Mai la carta completa nell'hero: solo artwork/crop --------------------
{
  const items = [item({ printingId: 'ygo1', catalogCardId: '46986414', cardName: 'Dark Magician', imageUrl: 'https://images.ygoprodeck.com/images/cards/46986414.jpg', referencePrice: 15, price24h: 10 })];
  const html = dashboardView(state, 'yugioh', { items });
  assert(html.includes('cards_cropped/46986414.jpg'), 'per Yu-Gi-Oh! l\'hero deve usare il crop, mai images/cards/<id>.jpg così com\'è');
  assert(!html.includes('images/cards/46986414.jpg'), 'l\'URL non-cropped non deve mai comparire come hero: solo la versione cards_cropped');
  console.log('PASS artwork: Yu-Gi-Oh! usa sempre cards_cropped nell\'hero quando disponibile, mai la carta intera');
}

// --- Grafico andamento prezzo: mensile finché <= 31 giorni di storico -----
{
  const now = Date.UTC(2026, 8, 15);
  const monthlyHistory = [
    { price: 8, capturedAt: new Date(now - 20 * 86400000).toISOString() },
    { price: 9, capturedAt: new Date(now - 10 * 86400000).toISOString() },
    { price: 12, capturedAt: new Date(now).toISOString() }
  ];
  const items = [item({ printingId: 'm1', catalogCardId: 'm1', cardName: 'Con storico mensile', referencePrice: 12, price24h: 10 })];
  const html = dashboardView(state, 'yugioh', { items, featuredHistory: new Map([['m1', monthlyHistory]]) });
  assert(html.includes('market-featured-chart') && html.includes('market-featured-chart-line'), 'il grafico deve comparire quando c\'è storico sufficiente');
  assert(html.includes('Andamento mensile'), 'con meno di un mese di storico deve mostrare una lettura mensile');
  assert(!html.includes('NaN'), 'nessun valore rotto nel grafico');
  console.log('PASS grafico andamento: lettura mensile quando lo storico copre meno di un mese');
}

// --- Grafico andamento prezzo: diventa annuale superato il mese -----------
{
  const now = Date.UTC(2026, 8, 15);
  const yearlyHistory = [
    { price: 6, capturedAt: new Date(now - 300 * 86400000).toISOString() },
    { price: 9, capturedAt: new Date(now - 120 * 86400000).toISOString() },
    { price: 12, capturedAt: new Date(now).toISOString() }
  ];
  const items = [item({ printingId: 'y1', catalogCardId: 'y1', cardName: 'Con storico annuale', referencePrice: 12, price24h: 10 })];
  const html = dashboardView(state, 'yugioh', { items, featuredHistory: new Map([['y1', yearlyHistory]]) });
  assert(html.includes('Andamento annuale'), 'superato il mese di storico disponibile, la lettura deve diventare annuale');
  assert(!html.includes('Andamento mensile'), 'non deve mostrare "mensile" quando lo storico supera abbondantemente un mese');
  console.log('PASS grafico andamento: diventa annuale quando lo storico disponibile supera un mese');
}

// --- Nessuno storico ancora disponibile: nessun grafico rotto -------------
{
  const items = [item({ printingId: 'noh1', catalogCardId: 'noh1', cardName: 'Senza storico', referencePrice: 12, price24h: 10 })];
  const html = dashboardView(state, 'yugioh', { items });
  assert(html.includes('market-featured-chart-empty'), 'senza storico disponibile deve mostrare uno stato vuoto dedicato, mai un grafico rotto');
  console.log('PASS grafico andamento: stato vuoto dedicato quando lo storico non è ancora disponibile');
}

// --- Edge case: meno di 3 movers, una sola slide senza navigazione --------
{
  const items = [item({ printingId: 'up1', catalogCardId: 'u1', cardName: 'Unica su', referencePrice: 11, price24h: 10 })];
  const html = dashboardView(state, 'yugioh', { items });
  assert(html.includes('Unica su'), 'l\'unico mover in salita deve comparire');
  assert(!html.includes('market-featured-nav'), 'con una sola slide non deve comparire alcuna navigazione inutile');
  console.log('PASS edge case: meno di 3 movers, una sola slide senza navigazione');
}

// --- Edge case: nessuna variazione (pannello vuoto) -----------------------
{
  const items = [item({ printingId: 'flat1', catalogCardId: 'f1', cardName: 'Stabile', referencePrice: 10, price24h: 10 })];
  const html = dashboardView(state, 'yugioh', { items });
  assert(html.includes('featured-empty'), 'senza movers in salita deve tornare lo stato vuoto del pannello');
  assert(html.includes('Nessuna variazione da mostrare'), 'messaggio di stato vuoto atteso');
  assert(!html.includes('market-featured-carousel'), 'lo stato vuoto non deve montare il carousel');
  console.log('PASS edge case: nessuna variazione, stato vuoto del pannello');
}

// --- Loading/errore: stato del pannello quando i trend non sono pronti ----
{
  const htmlLoading = dashboardView(state, 'yugioh', { items: [], trendsLoading: true });
  assert(htmlLoading.includes('Caricamento trend'), 'durante il caricamento deve mostrare uno stato dedicato, mai lo stato "nessuna variazione"');
  const htmlError = dashboardView(state, 'yugioh', { items: [], trendsError: true });
  assert(htmlError.includes('Trend non disponibili'), 'in errore deve mostrare uno stato dedicato con invito a riprovare da Market Watch');
  console.log('PASS stati loading/errore: distinti dallo stato "nessuna variazione", mai confusi tra loro');
}

// --- Edge case: artwork assente -> placeholder, mai un <img> rotto ---------
{
  const items = [item({ printingId: 'noart2', catalogCardId: 'n2', cardName: 'Su senza artwork', imageUrl: '', referencePrice: 12, price24h: 10 })];
  const html = dashboardView(state, 'yugioh', { items });
  assert(html.includes('market-featured-art-placeholder'), 'senza imageUrl l\'hero deve mostrare un placeholder elegante, mai un\'immagine rotta');
  console.log('PASS edge case: artwork assente, placeholder elegante nell\'hero, mai un\'immagine rotta');
}

// --- Prezzo precedente -> prezzo corrente, opzionale -----------------------
{
  const { mapDashboardMovers } = await import('../js/market-watch.js');
  const rpcShaped = mapDashboardMovers([{ printingId: 'rpc1', catalogCardId: 'rpc1', cardName: 'Dalla RPC', referencePrice: 9, positiveChange: 12.5 }]);
  const html = dashboardView(state, 'yugioh', { items: [], featuredMovers: rpcShaped });
  assert(html.includes('Dalla RPC'), 'un mover proveniente dalla RPC (senza price24h) deve comunque comparire nell\'hero');
  assert(!html.includes('undefined'), 'un campo mancante (price24h) non deve mai finire come testo "undefined" nel markup');
  console.log('PASS "prezzo precedente → prezzo corrente": opzionale, mai un valore rotto quando la RPC non lo fornisce');
}

// --- market.featuredMovers esplicitamente vuoto: non ricadere su un -------
// sottoinsieme parziale (ownedPage è paginata) quando la RPC ha già
// risposto "nessuna carta in crescita" (array vuoto, non undefined).
{
  const items = [item({ printingId: 'p1', catalogCardId: 'c1', cardName: 'Sarebbe salita', referencePrice: 50, price24h: 10 })];
  const html = dashboardView(state, 'yugioh', { items, featuredMovers: [] });
  assert(!html.includes('Sarebbe salita'), 'con featuredMovers=[] esplicito (risposta completa della RPC) non si deve ricadere su positiveMovers(items) — items è solo la pagina Raccolta caricata, non la collezione completa');
  console.log('PASS featuredMovers=[] esplicito: mai un fallback a un sottoinsieme parziale quando la RPC ha già risposto con zero carte');
}

console.log('PASS dashboard movers (logica pura): hero carousel solo artwork/solo carte in salita con grafico mensile/annuale, niente più liste Up/Down, tutti gli edge case richiesti');
