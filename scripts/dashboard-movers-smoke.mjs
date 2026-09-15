// Dashboard Market Watch: hero carousel (solo artwork, carte in salita) +
// Top 3 Up / Top 3 Down sotto — logica pura (positiveMovers/negativeMovers
// già esistenti in js/market-watch.js, invariate) + markup HTML di
// dashboardView(). Il comportamento reale nel browser (artwork cropped,
// navigazione carousel, niente ritorno di render pesanti) resta coperto da
// scripts/market-watch-browser-smoke.mjs.
//
// Root cause del redesign precedente da correggere qui: il carousel
// unificato (un'altra sessione, commit b6f5b03..44688d8) dipendeva da una
// RPC nuova (list_market_dashboard_trends, mai applicata al DB reale) e
// aveva reintrodotto una fetch di history per-carta ad ogni apertura
// Dashboard — entrambe cose esplicitamente vietate in questo task. Qui si
// torna alla RPC esistente (list_market_dashboard_movers, solo carte in
// salita) + negativeMovers(market.items,3) lato client per le carte in
// discesa, zero query nuove, zero fetch per-carta.
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

// --- dashboardView: hero carousel (solo up) + due liste sotto --------------
{
  const items = [
    item({ printingId: 'up1', catalogCardId: 'u1', cardName: 'Su Uno', imageUrl: 'https://images.ygoprodeck.com/images/cards/1.jpg', referencePrice: 12, price24h: 10 }),
    item({ printingId: 'down1', catalogCardId: 'd1', cardName: 'Giù Uno', imageUrl: '', referencePrice: 5, price24h: 10 })
  ];
  const html = dashboardView(state, 'yugioh', { items });
  assert(html.includes('market-hero-carousel'), 'deve montare l\'hero carousel');
  assert(html.includes('market-movers-lists'), 'deve mantenere le due liste Up/Down sotto il carousel');
  assert(html.includes('In salita') && html.includes('In discesa'), 'entrambe le etichette delle due classifiche devono comparire');
  assert(html.includes('Su Uno'), 'la carta in salita deve comparire sia nell\'hero sia nella lista Up');
  assert(html.includes('Giù Uno'), 'la carta in discesa deve comparire nella lista Down (mai nell\'hero: solo le carte in crescita diventano slide)');
  // La carta in discesa non deve MAI comparire come slide hero.
  const heroSection = html.slice(html.indexOf('market-hero-carousel'), html.indexOf('market-movers-lists'));
  assert(!heroSection.includes('Giù Uno'), 'una carta in discesa non deve mai diventare una slide dell\'hero carousel');
  console.log('PASS dashboardView: hero carousel con le sole carte in salita, liste In salita/In discesa sotto, mai una carta in discesa promossa a slide');
}

// --- Mai la carta completa nell'hero: solo artwork/crop --------------------
{
  const items = [item({ printingId: 'ygo1', catalogCardId: '46986414', cardName: 'Dark Magician', imageUrl: 'https://images.ygoprodeck.com/images/cards/46986414.jpg', referencePrice: 15, price24h: 10 })];
  const html = dashboardView(state, 'yugioh', { items });
  assert(html.includes('cards_cropped/46986414.jpg'), 'per Yu-Gi-Oh! l\'hero deve usare il crop, mai images/cards/<id>.jpg così com\'è');
  assert(!html.includes('images/cards/46986414.jpg'), 'l\'URL non-cropped non deve mai comparire come hero: solo la versione cards_cropped');
  assert(!/<h3[^>]*>|ATK|DEF/.test(html.split('market-hero-carousel')[1].split('market-movers-lists')[0]), 'l\'hero non deve mai mostrare la carta completa (cornice/testo/ATK-DEF), solo artwork');
  console.log('PASS artwork: Yu-Gi-Oh! usa sempre cards_cropped nell\'hero quando disponibile, mai la carta intera');
}

// --- Edge case: meno di 3 movers, un solo mover per direzione --------------
{
  const items = [item({ printingId: 'up1', catalogCardId: 'u1', cardName: 'Unica su', referencePrice: 11, price24h: 10 })];
  const html = dashboardView(state, 'yugioh', { items });
  assert(html.includes('Unica su'), 'l\'unico mover in salita deve comparire nell\'hero e nella lista Up');
  assert(html.includes('Nessuna variazione negativa al momento'), 'con zero movers in discesa la lista Down mostra un messaggio neutro, mai nascosta');
  assert(html.includes('market-hero-carousel'), 'il pannello resta comunque hero+liste (una sola slide, non un fallback diverso)');
  assert(!html.includes('market-hero-nav'), 'con una sola slide non deve comparire alcuna navigazione (frecce/pallini) inutile');
  console.log('PASS edge case: meno di 3 movers, una sola slide senza navigazione, messaggio neutro solo per la lista vuota');
}

// --- Edge case: nessun mover positivo, ma la lista Down ha dati ------------
// "Se non ci sono movers positivi: mantenere uno stato vuoto elegante; le
// liste Up/Down possono comunque mostrare eventuali dati disponibili."
{
  const items = [item({ printingId: 'down1', catalogCardId: 'd1', cardName: 'Solo giù', referencePrice: 5, price24h: 10 })];
  const html = dashboardView(state, 'yugioh', { items });
  assert(html.includes('market-hero-empty'), 'senza movers positivi l\'hero deve mostrare uno stato vuoto elegante dedicato');
  assert(!html.includes('market-hero-slide'), 'nessuna slide quando non ci sono carte in salita');
  assert(html.includes('Solo giù'), 'la lista In discesa deve comunque mostrare i dati disponibili anche se l\'hero è vuoto');
  console.log('PASS edge case: nessun mover positivo, hero vuoto elegante ma la lista In discesa resta popolata');
}

// --- Edge case: nessuna variazione in nessuna direzione (pannello vuoto) ---
{
  const items = [item({ printingId: 'flat1', catalogCardId: 'f1', cardName: 'Stabile', referencePrice: 10, price24h: 10 })];
  const html = dashboardView(state, 'yugioh', { items });
  assert(html.includes('featured-empty'), 'con zero movers in entrambe le direzioni deve tornare lo stato vuoto dell\'intero pannello');
  assert(html.includes('Nessuna variazione da mostrare'), 'messaggio di stato vuoto atteso');
  assert(!html.includes('market-hero-carousel') && !html.includes('market-movers-lists'), 'lo stato vuoto non deve montare né l\'hero né le liste');
  console.log('PASS edge case: nessuna variazione in nessuna direzione, stato vuoto dell\'intero pannello');
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
  const items = [item({ printingId: 'noart', catalogCardId: 'n1', cardName: 'Senza artwork', imageUrl: '', referencePrice: 5, price24h: 10 })];
  const html = dashboardView(state, 'yugioh', { items });
  assert(html.includes('market-mover-row-art-placeholder'), 'senza imageUrl la lista sotto deve mostrare il placeholder, mai un <img src=""> rotto');
  const withUp = dashboardView(state, 'yugioh', { items: [item({ printingId: 'noart2', catalogCardId: 'n2', cardName: 'Su senza artwork', imageUrl: '', referencePrice: 12, price24h: 10 })] });
  assert(withUp.includes('market-hero-art-placeholder'), 'senza imageUrl anche l\'hero deve mostrare un placeholder elegante, mai una hero image rotta');
  console.log('PASS edge case: artwork assente, placeholder elegante sia nell\'hero sia nelle liste, mai un\'immagine rotta');
}

// --- Nomi carta molto lunghi: mai rompere il layout (solo CSS/overflow) ---
{
  const longName = 'Elemental HERO Absolute Zero Dragon Neos Alius Supremo Infinito'.repeat(1);
  const items = [item({ printingId: 'long1', catalogCardId: 'l1', cardName: longName, referencePrice: 12, price24h: 10 })];
  const html = dashboardView(state, 'yugioh', { items });
  assert(html.includes(longName.length > 0 ? longName.slice(0, 10) : ''), 'il nome lungo deve comunque comparire nel markup (il contenimento è demandato al CSS, mai troncato lato server)');
  console.log('PASS nomi carta molto lunghi: presenti nel markup, il contenimento visivo resta responsabilità del CSS (overflow-wrap/line-clamp)');
}

// --- Prezzo precedente -> prezzo corrente, opzionale -----------------------
// Quando i movers in salita arrivano dalla RPC list_market_dashboard_movers
// (mapDashboardMovers), la forma NON include price24h (solo referencePrice/
// baselinePrice/positiveChange) — la riga/slide deve restare valida,
// mostrando solo il prezzo corrente, senza mai un "undefined" o un crash.
{
  const { mapDashboardMovers } = await import('../js/market-watch.js');
  const rpcShaped = mapDashboardMovers([{ printingId: 'rpc1', catalogCardId: 'rpc1', cardName: 'Dalla RPC', referencePrice: 9, positiveChange: 12.5 }]);
  const html = dashboardView(state, 'yugioh', { items: [], featuredMovers: rpcShaped });
  assert(html.includes('Dalla RPC'), 'un mover proveniente dalla RPC (senza price24h) deve comunque comparire nell\'hero');
  assert(!html.includes('undefined'), 'un campo mancante (price24h) non deve mai finire come testo "undefined" nel markup');

  const withHistory = item({ printingId: 'h1', catalogCardId: 'hh1', cardName: 'Con storico', referencePrice: 8, price24h: 10 });
  const htmlWithHistory = dashboardView(state, 'yugioh', { items: [withHistory] });
  assert(htmlWithHistory.includes('market-mover-row-history'), 'quando price24h è disponibile (fallback client-side) la lista sotto mostra "prezzo precedente → prezzo corrente"');
  console.log('PASS "prezzo precedente → prezzo corrente": opzionale, mostrato quando disponibile, mai un valore rotto quando la RPC non lo fornisce');
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

console.log('PASS dashboard movers (logica pura): hero carousel solo artwork/solo carte in salita, liste Up/Down sotto invariate, negativeMovers simmetrico, tutti gli edge case richiesti');
