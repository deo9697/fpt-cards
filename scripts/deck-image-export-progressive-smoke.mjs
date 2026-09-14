// Decklist Image Generator — caricamento progressivo (logica pura, nessun
// browser/canvas reale necessario: un <canvas> fittizio con lo stesso
// contratto usato da drawDeckImage/exportDeckImageBlob è sufficiente).
// Verifica qui, in modo deterministico (timer controllati, mai una vera
// rete/Image): il limite di concorrenza 6-8, il riuso della cache di
// sessione (mai un ri-fetch di un URL già risolto), il timeout breve per
// immagine durante la preview con fallback a placeholder e successivo
// "upgrade tardivo" quando il caricamento reale arriva più tardi, il tetto
// globale ragionevole per l'export finale, e — la prova richiesta
// esplicitamente — che renderDeckImagePreview disegna il primo frame PRIMA
// che una qualunque immagine abbia avuto la possibilità di risolversi.
// Il comportamento con artwork reali/CORS/canvas vero resta coperto da
// scripts/deck-image-export-browser-smoke.mjs (Chrome reale via CDP), che
// aggiunge anche una prova equivalente con Image reali e One Piece via UI.
import assert from 'node:assert/strict';
globalThis.window ??= { addEventListener: () => {}, FPT_CONFIG: undefined };
globalThis.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const {
  createDeckImageCache, resolveDeckImageUrls, preloadDeckImagesProgressively, waitForPendingDeckImages,
  renderDeckImage, renderDeckImagePreview, exportDeckImageBlob, normalizeDeckForImage
} = await import('../js/deck-image-export.js');

function ygoDeck(cards, overrides = {}) {
  return { name: 'Progressive Test', game: 'yugioh', format: '', deckTheme: 'arcane-purple', signatureCardId: null, cards, ...overrides };
}
function card(id, section, imageUrl) { return { catalogCardId: id, cardName: id, section, quantity: 1, imageUrl }; }

// Image fittizia con timing/esito controllabili per URL, per non dipendere
// mai da rete/canvas reali. onload/onerror vengono assegnati dal chiamante
// (loadImageReal) PRIMA di impostare .src, quindi è sempre sicuro schedulare
// la risoluzione dal setter di src.
function installFakeImage({ configs = new Map(), activity = { active: 0, max: 0, started: 0 } } = {}) {
  const original = globalThis.Image;
  class FakeImage {
    constructor() { this.width = 300; this.height = 400; this.crossOrigin = null; }
    set src(url) {
      this._src = url;
      const cfg = configs.get(url) || {};
      activity.started++; activity.active++; activity.max = Math.max(activity.max, activity.active);
      if (cfg.never) return; // non risolve mai, per testare il tetto globale dell'export
      setTimeout(() => {
        activity.active--;
        if (cfg.fail) this.onerror?.();
        else this.onload?.();
      }, cfg.delayMs ?? 5);
    }
    get src() { return this._src; }
  }
  globalThis.Image = FakeImage;
  return { activity, restore: () => { globalThis.Image = original; } };
}

function fakeCanvas() {
  const calls = { clearRect: 0, drawImage: 0, toBlobCount: 0 };
  const ctx = {
    clearRect() { calls.clearRect++; }, fillRect() {}, fillText() {}, strokeRect() {},
    save() {}, restore() {}, beginPath() {}, closePath() {}, arcTo() {}, arc() {}, clip() {},
    drawImage() { calls.drawImage++; }, moveTo() {}, lineTo() {}, stroke() {},
    measureText: text => ({ width: String(text || '').length * 8 }),
    set fillStyle(_v) {}, set strokeStyle(_v) {}, set lineWidth(_v) {}, set font(_v) {},
    set textAlign(_v) {}, set textBaseline(_v) {}, set filter(_v) {}
  };
  return { canvas: { width: 0, height: 0, getContext: () => ctx, toBlob(cb, type) { calls.toBlobCount++; cb({ type, size: 42 }); } }, calls };
}

// --- resolveDeckImageUrls: dedup su tutte le sezioni + signature ----------
{
  // catalogCardId volutamente NON puramente numerico: preferredDeckArtwork()
  // (js/deck-box.js, riusata e mai duplicata) forza un URL ygoprodeck per id
  // puramente numerici, ignorando l'imageUrl fornito — qui serve invece
  // controllare l'URL esatto per verificare il dedup.
  const deck = ygoDeck([card('c1', 'main', 'a.png'), card('c2', 'main', 'b.png'), card('c3', 'extra', 'a.png'), card('c4', 'side', '')], { signatureCardId: 'c2' });
  const model = normalizeDeckForImage(deck);
  const urls = resolveDeckImageUrls(model);
  assert.deepEqual(urls, ['a.png', 'b.png'], 'ogni URL deve comparire una sola volta, incluso quello riusato dalla signature card');
  console.log('PASS resolveDeckImageUrls: dedup corretto su sezioni multiple + signature card, mai un fetch duplicato programmato');
}

// --- Limite di concorrenza: mai più di N caricamenti reali attivi insieme ---
{
  const cards = Array.from({ length: 20 }, (_, i) => card(`u${i}`, 'main', `img-${i}.png`));
  const model = normalizeDeckForImage(ygoDeck(cards));
  const { activity, restore } = installFakeImage({ configs: new Map(cards.map(c => [c.imageUrl, { delayMs: 25 }])) });
  try {
    const cache = createDeckImageCache();
    await preloadDeckImagesProgressively(model, { cache, concurrency: 6, previewTimeoutMs: 5000 });
    assert.equal(activity.max, 6, `non deve mai superare la concorrenza richiesta (osservato massimo: ${activity.max})`);
    assert.equal(activity.started, 20, 'tutte le 20 immagini uniche devono essere state richieste, nessuna saltata');
    assert.equal(cache.images.size, 20);
    assert.equal(cache.inFlight.size, 0, 'a preload concluso non deve restare nulla in cache.inFlight');
  } finally { restore(); }
  console.log('PASS concorrenza limitata: mai più di 6 caricamenti reali attivi contemporaneamente su 20 URL uniche, tutte comunque risolte');
}

// --- Cache di sessione: un URL già risolto non viene MAI ri-richiesto -----
{
  const model = normalizeDeckForImage(ygoDeck([card('c1', 'main', 'cached.png')]));
  const cache = createDeckImageCache();
  {
    const { restore } = installFakeImage({ configs: new Map([['cached.png', { delayMs: 5 }]]) });
    try { await preloadDeckImagesProgressively(model, { cache, concurrency: 6, previewTimeoutMs: 2000 }); } finally { restore(); }
  }
  assert.notEqual(cache.images.get('cached.png'), undefined);
  let refetches = 0;
  const { restore } = installFakeImage(); // qualunque `new Image()` qui sotto sarebbe un ri-fetch indebito
  const originalImage = globalThis.Image;
  globalThis.Image = class { constructor() { refetches++; } set src(_v) {} };
  try { await preloadDeckImagesProgressively(model, { cache, concurrency: 6, previewTimeoutMs: 2000 }); }
  finally { globalThis.Image = originalImage; restore(); }
  assert.equal(refetches, 0, 'un URL già presente in cache.images non deve mai generare un nuovo new Image()');
  console.log('PASS cache di sessione: un secondo preload sullo stesso URL non ri-richiede mai l\'artwork già risolto');
}

// --- Timeout breve in preview: placeholder subito, poi upgrade tardivo ----
{
  const url = 'slow.png';
  const model = normalizeDeckForImage(ygoDeck([card('c1', 'main', url)]));
  const cache = createDeckImageCache();
  const settled = [];
  const { restore } = installFakeImage({ configs: new Map([[url, { delayMs: 300 }]]) });
  try {
    await preloadDeckImagesProgressively(model, { cache, concurrency: 6, previewTimeoutMs: 30, onImageSettled: (u, img) => settled.push([u, img]) });
    assert.equal(cache.images.has(url), false, 'entro il timeout breve di preview il caricamento reale (300ms) non può essere già finito: deve restare un placeholder');
    assert.equal(cache.inFlight.has(url), true, 'il caricamento reale deve proseguire in background, mai annullato dal timeout di preview');
    assert.equal(settled.length, 0, 'nessun redraw incrementale prima che l\'immagine arrivi davvero');

    await waitForPendingDeckImages(cache, { timeoutMs: 2000 });
    assert.notEqual(cache.images.get(url), undefined, 'dopo l\'attesa mirata ai soli pendenti, l\'artwork arrivato in ritardo deve aggiornare la cache (upgrade tardivo)');
    assert.equal(cache.inFlight.has(url), false);
    assert.equal(settled.length, 1, 'onImageSettled deve scattare esattamente quando il caricamento reale, arrivato in ritardo, si risolve');
  } finally { restore(); }
  console.log('PASS timeout breve di preview: placeholder immediato per un artwork lento, upgrade automatico non appena il caricamento reale arriva (mai perso, mai bloccante)');
}

// --- Artwork fallito: placeholder permanente, mai un errore/throw --------
{
  const url = 'broken.png';
  const model = normalizeDeckForImage(ygoDeck([card('c1', 'main', url)]));
  const cache = createDeckImageCache();
  const { restore } = installFakeImage({ configs: new Map([[url, { fail: true, delayMs: 5 }]]) });
  try {
    await preloadDeckImagesProgressively(model, { cache, concurrency: 6, previewTimeoutMs: 2000 });
    assert.equal(cache.images.get(url), null, 'un artwork fallito risolve a null (placeholder), mai un throw che blocchi l\'intero export');
  } finally { restore(); }
  console.log('PASS artwork fallito: null in cache (placeholder), nessuna eccezione propagata');
}

// --- Tetto globale export: mai bloccato all\'infinito da uno straggler ----
{
  const url = 'never.png';
  const model = normalizeDeckForImage(ygoDeck([card('c1', 'main', url)]));
  const cache = createDeckImageCache();
  const { restore } = installFakeImage({ configs: new Map([[url, { never: true }]]) });
  try {
    await preloadDeckImagesProgressively(model, { cache, concurrency: 6, previewTimeoutMs: 10 });
    assert.equal(cache.inFlight.has(url), true);
    const start = Date.now();
    await waitForPendingDeckImages(cache, { timeoutMs: 150 });
    const elapsed = Date.now() - start;
    assert(elapsed < 1000, `waitForPendingDeckImages deve rispettare il tetto globale, non attendere all'infinito (atteso: ${elapsed}ms)`);
    assert.equal(cache.inFlight.has(url), true, 'lo straggler resta in cache.inFlight (potrà ancora risolversi più tardi), semplicemente non lo si attende oltre il tetto');
  } finally { restore(); }
  console.log('PASS tetto globale export: waitForPendingDeckImages ritorna comunque entro il limite anche con un artwork che non risponde mai');
}

// --- exportDeckImageBlob: aspetta SOLO i pendenti, poi un ultimo redraw ---
{
  const url = 'export-slow.png';
  const model = normalizeDeckForImage(ygoDeck([card('c1', 'main', url)]));
  const cache = createDeckImageCache();
  const { restore } = installFakeImage({ configs: new Map([[url, { delayMs: 60 }]]) });
  try {
    await preloadDeckImagesProgressively(model, { cache, concurrency: 6, previewTimeoutMs: 10 }); // lascia lo straggler pendente
    assert.equal(cache.inFlight.has(url), true);
    const { canvas, calls } = fakeCanvas();
    const clearRectBefore = calls.clearRect;
    const blob = await exportDeckImageBlob(canvas, { cache, model, layout: { width: 1080, height: 1350, padding: 0, header: { x: 0, y: 0, width: 100 }, sections: [], footer: { x: 0, y: 0, width: 100 } }, mode: 'clean', exportTimeoutMs: 2000 });
    assert.equal(blob.type, 'image/png'); assert.equal(calls.toBlobCount, 1);
    assert.equal(cache.inFlight.has(url), false, 'l\'export deve aver atteso il completamento dello straggler');
    assert(calls.clearRect > clearRectBefore, 'un ultimo redraw deve avvenire dopo aver atteso i pendenti, prima del toBlob');
  } finally { restore(); }
  console.log('PASS exportDeckImageBlob: attende solo le richieste ancora pendenti (bounded), poi un ultimo redraw prima del PNG');
}

// --- exportDeckImageBlob: retrocompatibile con la firma a un solo argomento ---
{
  const { canvas, calls } = fakeCanvas();
  const blob = await exportDeckImageBlob(canvas);
  assert.equal(blob.type, 'image/png'); assert.equal(calls.toBlobCount, 1);
  console.log('PASS exportDeckImageBlob: firma a un argomento (nessun cache/model/layout) resta valida, comportamento invariato');
}

// --- renderDeckImage (bloccante): contratto esterno invariato -------------
{
  const model = ygoDeck([card('c1', 'main', 'blocking.png')]);
  const { restore } = installFakeImage({ configs: new Map([['blocking.png', { delayMs: 10 }]]) });
  try {
    const { canvas, calls } = fakeCanvas();
    const result = await renderDeckImage(model, { canvas });
    assert.equal(result.mode, 'clean');
    assert(calls.clearRect >= 1, 'deve comunque disegnare almeno un frame');
  } finally { restore(); }
  console.log('PASS renderDeckImage: resta pienamente bloccante (un solo frame finale, preload atteso), contratto esterno invariato per i chiamanti esistenti');
}

// --- renderDeckImagePreview: la PROVA richiesta esplicitamente -----------
// Il primo frame deve essere disegnato in modo SINCRONO, prima che una
// qualunque immagine reale abbia anche solo la possibilità di risolversi
// (nessun timer/microtask può essere scattato tra la chiamata e il return).
{
  const url = 'preview-proof.png';
  const model = ygoDeck([card('c1', 'main', url)]);
  const { activity, restore } = installFakeImage({ configs: new Map([[url, { delayMs: 40 }]]) });
  try {
    const { canvas, calls } = fakeCanvas();
    const result = renderDeckImagePreview(model, { canvas, previewTimeoutMs: 1000, concurrency: 6 });
    // Punto di osservazione SINCRONO, immediatamente dopo la chiamata: nessun
    // await è ancora avvenuto in questo test, quindi nessun timer del fake
    // Image (delayMs:40) può essere scattato — la preview è quindi
    // dimostrabilmente comparsa PRIMA del completamento di qualunque immagine.
    assert(calls.clearRect >= 1, 'il primo frame (con placeholder) deve essere disegnato in modo sincrono, senza attendere il preload');
    assert.equal(activity.active, 1, 'il caricamento reale deve essere stato avviato ma non ancora concluso al momento del primo frame');
    assert.equal(result.cache.images.has(url), false, 'nessuna immagine può già essere risolta al ritorno sincrono della funzione');

    const clearRectAfterFirstFrame = calls.clearRect;
    await result.ready;
    assert(calls.clearRect > clearRectAfterFirstFrame, 'deve avvenire un secondo redraw incrementale dopo che l\'artwork è arrivato');
    assert.notEqual(result.cache.images.get(url), undefined);
  } finally { restore(); }
  console.log('PASS renderDeckImagePreview: primo frame disegnato in modo sincrono con placeholder PRIMA che qualunque immagine sia risolta, poi redraw incrementale automatico');
}

// --- One Piece: stessa pipeline progressiva, adapter leader/main/don -----
// riusati senza alcun branching hardcoded aggiuntivo (nessun `if game ===
// 'yugioh'` da nessuna parte in questo modulo).
{
  const deck = { name: 'Luffy Rush', game: 'onepiece', format: '', deckTheme: null, signatureCardId: null, cards: [
    card('OP01-001', 'leader', 'leader.png'), card('OP01-016', 'main', 'main.png'), card('don-1', 'don', '')
  ] };
  const { restore } = installFakeImage({ configs: new Map([['leader.png', { delayMs: 15 }], ['main.png', { delayMs: 5 }]]) });
  try {
    const { canvas, calls } = fakeCanvas();
    const { ready, model, cache } = renderDeckImagePreview(deck, { canvas, previewTimeoutMs: 1000, concurrency: 6 });
    assert.equal(model.sections.map(s => s.key).join(','), 'leader,main,don', 'la pipeline progressiva deve riusare le sezioni reali dell\'adapter One Piece, non main/extra/side');
    await ready;
    assert.notEqual(cache.images.get('leader.png'), undefined);
    assert.notEqual(cache.images.get('main.png'), undefined);
    assert(calls.clearRect >= 1);
  } finally { restore(); }
  console.log('PASS One Piece: caricamento progressivo funziona identico su leader/main/don, riusando gli stessi adapter senza branching duplicato');
}

console.log('PASS deck-image-export caricamento progressivo: concorrenza limitata, cache di sessione mai ri-fetchata, timeout breve con upgrade tardivo, tetto globale export, preview sincrona prima del preload, retrocompatibilità, One Piece incluso');
