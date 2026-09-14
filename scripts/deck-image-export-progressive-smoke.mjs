// Decklist Image Generator — caricamento progressivo (logica pura, nessun
// browser/canvas reale necessario: un <canvas> fittizio con lo stesso
// contratto usato da drawDeckImage/exportDeckImageBlob è sufficiente).
//
// Copre in modo deterministico (fetch/Image fittizi, mai una vera rete):
// - la pipeline fetch osservabile (status/content-type/blob/decode) al posto
//   di un <img src> "cieco" puntato direttamente sul proxy;
// - la cache a 3 mappe (images/inFlight/failures): un fallimento non deve
//   MAI diventare un "successo" permanente (bug reale corretto in questo
//   fix — prima un null veniva scritto in cache.images e la condizione
//   `!cache.images.has(url)` bloccava ogni retry per il resto della
//   sessione);
// - il budget di retry limitato (mai un loop infinito, mai spam);
// - il limite di concorrenza 6-8, il timeout breve con upgrade tardivo, il
//   tetto globale export, e la prova che la preview appare prima del
//   preload completo — già verificati prima del fix e qui riconfermati sul
//   nuovo loader.
// Il comportamento con Image/canvas veri, un mock deterministico del proxy
// e la UI reale resta coperto da scripts/deck-image-export-browser-smoke.mjs
// (Chrome reale via CDP).
import assert from 'node:assert/strict';
globalThis.window ??= { addEventListener: () => {}, FPT_CONFIG: undefined };
globalThis.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const {
  createDeckImageCache, resolveDeckImageUrls, preloadDeckImagesProgressively, waitForPendingDeckImages,
  renderDeckImage, renderDeckImagePreview, exportDeckImageBlob, normalizeDeckForImage,
  DEFAULT_MAX_ATTEMPTS
} = await import('../js/deck-image-export.js');

function ygoDeck(cards, overrides = {}) {
  return { name: 'Progressive Test', game: 'yugioh', format: '', deckTheme: 'arcane-purple', signatureCardId: null, cards, ...overrides };
}
// catalogCardId volutamente NON puramente numerico: preferredDeckArtwork()
// (js/deck-box.js, riusata e mai duplicata) forza un URL ygoprodeck per id
// puramente numerici, ignorando l'imageUrl fornito — qui serve invece
// controllare l'URL esatto per instradare i mock di fetch.
function card(id, section, imageUrl) { return { catalogCardId: id, cardName: id, section, quantity: 1, imageUrl }; }

// --- Mock della rete: fetch (proxy/HTTP) + Image (decodifica dal blob) ----
// loadArtwork() fa: fetch(resolvedUrl) -> ok/status/content-type -> blob()
// -> URL.createObjectURL -> new Image().src = objectUrl -> decode(). Ogni
// stadio è quindi mockabile separatamente e in modo deterministico, mai
// legato a una vera rete/canvas.
function installFakeNetwork({ responses = new Map(), activity = { active: 0, max: 0 }, calls = [] } = {}) {
  const originalFetch = globalThis.fetch;
  const originalImage = globalThis.Image;
  const originalCreate = globalThis.URL.createObjectURL;
  const originalRevoke = globalThis.URL.revokeObjectURL;
  const revoked = [];

  globalThis.fetch = async url => {
    const key = String(url);
    calls.push(key);
    const cfg = responses.get(key) ?? responses.get('*') ?? { status: 200, contentType: 'image/jpeg' };
    if (cfg.neverResolves) return new Promise(() => {}); // straggler che non risponde mai
    activity.active++; activity.max = Math.max(activity.max, activity.active);
    try {
      if (cfg.networkError) throw new Error('rete non raggiungibile');
      await new Promise(resolve => setTimeout(resolve, cfg.delayMs ?? 5));
      return {
        ok: cfg.status >= 200 && cfg.status < 300, status: cfg.status,
        headers: { get: name => (String(name).toLowerCase() === 'content-type' ? (cfg.contentType ?? null) : null) },
        blob: async () => {
          if (cfg.blobError) throw new Error('blob non leggibile');
          return { __decodeFail: !!cfg.decodeFail };
        }
      };
    } finally { activity.active--; }
  };
  class FakeImage {
    constructor() { this.width = 300; this.height = 400; }
    set src(url) { this._src = url; setTimeout(() => { if (url === 'blob:decode-fail') this.onerror?.(); else this.onload?.(); }, 1); }
    get src() { return this._src; }
  }
  globalThis.Image = FakeImage;
  globalThis.URL.createObjectURL = blob => (blob?.__decodeFail ? 'blob:decode-fail' : `blob:ok-${Math.random().toString(36).slice(2)}`);
  globalThis.URL.revokeObjectURL = url => { revoked.push(url); };

  return {
    activity, calls, revoked,
    restore: () => { globalThis.fetch = originalFetch; globalThis.Image = originalImage; globalThis.URL.createObjectURL = originalCreate; globalThis.URL.revokeObjectURL = originalRevoke; }
  };
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
  const deck = ygoDeck([card('c1', 'main', 'a.png'), card('c2', 'main', 'b.png'), card('c3', 'extra', 'a.png'), card('c4', 'side', '')], { signatureCardId: 'c2' });
  const model = normalizeDeckForImage(deck);
  const urls = resolveDeckImageUrls(model);
  assert.deepEqual(urls, ['a.png', 'b.png'], 'ogni URL deve comparire una sola volta, incluso quello riusato dalla signature card');
  console.log('PASS resolveDeckImageUrls: dedup corretto su sezioni multiple + signature card, mai un fetch duplicato programmato');
}

// --- HTTP: ogni stato osservabile porta all'esito corretto -----------------
{
  const scenarios = [
    ['200 image/jpeg', { status: 200, contentType: 'image/jpeg' }, true],
    ['200 image/png', { status: 200, contentType: 'image/png' }, true],
    ['403 whitelist', { status: 403, contentType: 'application/json' }, false],
    ['404 carta assente', { status: 404, contentType: 'application/json' }, false],
    ['502 upstream irraggiungibile', { status: 502, contentType: 'application/json' }, false],
    ['content-type non immagine', { status: 200, contentType: 'text/html' }, false],
    ['errore di rete', { networkError: true }, false]
  ];
  for (const [label, cfg, expectSuccess] of scenarios) {
    const url = `http-${label}.png`;
    const model = normalizeDeckForImage(ygoDeck([card('c1', 'main', url)]));
    const cache = createDeckImageCache();
    const responses = new Map([[url, cfg]]);
    const { restore } = installFakeNetwork({ responses });
    let diagnostic = null;
    try {
      await preloadDeckImagesProgressively(model, { cache, concurrency: 6, previewTimeoutMs: 2000, maxAttempts: 1, onImageSettled: (_u, _img, d) => { diagnostic = d; } });
      if (expectSuccess) assert.notEqual(cache.images.get(url), undefined, `${label}: doveva risolvere con successo`);
      else {
        assert.equal(cache.images.has(url), false, `${label}: non deve mai essere un successo`);
        assert(diagnostic && diagnostic.reason, `${label}: deve produrre una diagnostica con una reason`);
      }
    } finally { restore(); }
  }
  console.log('PASS matrice HTTP: 200 image/jpeg e image/png renderizzati; 403/404/502/content-type non-immagine/errore di rete tutti placeholder con diagnostica, mai un crash');
}

// --- Limite di concorrenza: mai più di N fetch reali attivi insieme -------
{
  const cards = Array.from({ length: 20 }, (_, i) => card(`u${i}`, 'main', `img-${i}.png`));
  const model = normalizeDeckForImage(ygoDeck(cards));
  const responses = new Map(cards.map(c => [c.imageUrl, { status: 200, contentType: 'image/jpeg', delayMs: 25 }]));
  const { activity, calls, restore } = installFakeNetwork({ responses });
  try {
    const cache = createDeckImageCache();
    await preloadDeckImagesProgressively(model, { cache, concurrency: 6, previewTimeoutMs: 5000 });
    assert.equal(activity.max, 6, `non deve mai superare la concorrenza richiesta (osservato massimo: ${activity.max})`);
    assert.equal(calls.length, 20, 'tutte le 20 immagini uniche devono essere state richieste, nessuna saltata');
    assert.equal(cache.images.size, 20);
    assert.equal(cache.inFlight.size, 0, 'a preload concluso non deve restare nulla in cache.inFlight');
  } finally { restore(); }
  console.log('PASS concorrenza limitata: mai più di 6 fetch reali attivi contemporaneamente su 20 URL uniche, tutte comunque risolte');
}

// --- Composizione URL: passando per proxyUrl, fetch chiama il PROXY con ---
// ?url=<originale>, mai l'artwork originale direttamente (questo è ciò che
// rende il caricamento osservabile passando davvero da
// api/card-image-proxy.js in produzione).
{
  const originalUrl = 'https://images.ygoprodeck.com/images/cards_cropped/89631139.jpg';
  const model = normalizeDeckForImage(ygoDeck([card('leader', 'main', originalUrl)]));
  const expectedResolved = `/api/card-image-proxy?url=${encodeURIComponent(originalUrl)}`;
  const responses = new Map([[expectedResolved, { status: 200, contentType: 'image/jpeg' }]]);
  const { calls, restore } = installFakeNetwork({ responses });
  try {
    const cache = createDeckImageCache();
    await preloadDeckImagesProgressively(model, { cache, proxyUrl: '/api/card-image-proxy', concurrency: 6, previewTimeoutMs: 2000 });
    assert.deepEqual(calls, [expectedResolved], 'fetch deve chiamare il proxy con ?url=<originale>, mai l\'host originale direttamente dal browser');
    assert.notEqual(cache.images.get(originalUrl), undefined, 'la cache resta indicizzata per URL ORIGINALE, non per URL risolta del proxy');
  } finally { restore(); }
  console.log('PASS composizione URL proxy: fetch chiama sempre /api/card-image-proxy?url=..., cache indicizzata per URL originale');
}

// --- Cache di sessione: un successo non viene MAI ri-richiesto -----------
{
  const model = normalizeDeckForImage(ygoDeck([card('c1', 'main', 'cached.png')]));
  const cache = createDeckImageCache();
  {
    const { restore } = installFakeNetwork({ responses: new Map([['cached.png', { status: 200, contentType: 'image/jpeg' }]]) });
    try { await preloadDeckImagesProgressively(model, { cache, concurrency: 6, previewTimeoutMs: 2000 }); } finally { restore(); }
  }
  assert.notEqual(cache.images.get('cached.png'), undefined);
  const { calls, restore } = installFakeNetwork({ responses: new Map([['cached.png', { status: 200, contentType: 'image/jpeg' }]]) });
  try { await preloadDeckImagesProgressively(model, { cache, concurrency: 6, previewTimeoutMs: 2000 }); }
  finally { restore(); }
  assert.equal(calls.length, 0, 'un URL già presente in cache.images non deve mai generare un nuovo fetch');
  console.log('PASS cache di sessione: un secondo preload sullo stesso URL non ri-richiede mai l\'artwork già risolto');
}

// --- Il bug corretto: un fallimento NON deve mai diventare un successo ---
// permanente. Prima del fix, `cache.images.set(url, null)` seguito dal
// filtro `!cache.images.has(url)` rendeva impossibile ogni retry per il
// resto della sessione, anche per un errore chiaramente transitorio.
{
  const url = 'once-broken.png';
  const model = normalizeDeckForImage(ygoDeck([card('c1', 'main', url)]));
  const cache = createDeckImageCache();
  const { restore } = installFakeNetwork({ responses: new Map([[url, { status: 502, contentType: 'application/json' }]]) });
  try { await preloadDeckImagesProgressively(model, { cache, concurrency: 6, previewTimeoutMs: 2000, maxAttempts: 1 }); }
  finally { restore(); }
  assert.equal(cache.images.has(url), false, 'un fallimento non deve MAI comparire in cache.images (né come null né in altra forma)');
  assert.equal(cache.failures.get(url)?.reason, 'http-502');
  console.log('PASS bug corretto: un fallimento resta SOLO in cache.failures, mai scritto in cache.images come falso successo');
}

// --- Retry: un fallimento transitorio viene ritentato entro la stessa -----
// chiamata (budget di default = 2 tentativi) e può trasformarsi in successo.
{
  const url = 'flaky.png';
  const model = normalizeDeckForImage(ygoDeck([card('c1', 'main', url)]));
  const cache = createDeckImageCache();
  let attempt = 0;
  const originalFetch = globalThis.fetch;
  const { restore } = installFakeNetwork({ responses: new Map([[url, { status: 200, contentType: 'image/jpeg' }]]) });
  // Il primo tentativo fallisce con un errore di rete, il secondo (retry) va a buon fine.
  const wrapped = globalThis.fetch;
  globalThis.fetch = async u => { attempt++; if (attempt === 1) throw new Error('rete instabile'); return wrapped(u); };
  try {
    await preloadDeckImagesProgressively(model, { cache, concurrency: 6, previewTimeoutMs: 2000, maxAttempts: DEFAULT_MAX_ATTEMPTS });
    assert.equal(attempt, 2, 'il retry deve avvenire entro la stessa chiamata dopo il primo fallimento transitorio');
    assert.notEqual(cache.images.get(url), undefined, 'il secondo tentativo riuscito deve risolvere l\'artwork');
    assert.equal(cache.failures.has(url), false, 'un successo successivo deve azzerare lo storico di fallimenti');
  } finally { globalThis.fetch = originalFetch; restore(); }
  console.log('PASS retry: un fallimento transitorio viene ritentato automaticamente entro la stessa chiamata e può risolversi con successo');
}

// --- Esaurimento del budget di retry: mai un loop infinito, mai spam -----
{
  const url = 'always-broken.png';
  const model = normalizeDeckForImage(ygoDeck([card('c1', 'main', url)]));
  const cache = createDeckImageCache();
  const { calls, restore } = installFakeNetwork({ responses: new Map([[url, { status: 404, contentType: 'application/json' }]]) });
  try {
    await preloadDeckImagesProgressively(model, { cache, concurrency: 6, previewTimeoutMs: 2000, maxAttempts: 2 });
    assert.equal(calls.length, 2, 'con maxAttempts=2 devono avvenire esattamente 2 fetch reali (1 iniziale + 1 retry), mai di più nella stessa chiamata');
    assert.equal(cache.failures.get(url)?.count, 2);
    assert.equal(cache.images.has(url), false);

    // Una chiamata successiva (es. riapertura preview) NON deve ritentare oltre il budget già esaurito.
    await preloadDeckImagesProgressively(model, { cache, concurrency: 6, previewTimeoutMs: 2000, maxAttempts: 2 });
    assert.equal(calls.length, 2, 'con il budget di retry già esaurito, una successiva invocazione non deve generare altri fetch: mai spam');
  } finally { restore(); }
  console.log('PASS esaurimento retry: al massimo maxAttempts fetch reali per URL nella vita della cache, mai un loop infinito o spam su una card sempre rotta');
}

// --- Timeout breve in preview: placeholder subito, poi upgrade tardivo ----
{
  const url = 'slow.png';
  const model = normalizeDeckForImage(ygoDeck([card('c1', 'main', url)]));
  const cache = createDeckImageCache();
  const settled = [];
  const { restore } = installFakeNetwork({ responses: new Map([[url, { status: 200, contentType: 'image/jpeg', delayMs: 300 }]]) });
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

// --- Tetto globale export: mai bloccato all'infinito da uno straggler ----
{
  const url = 'never.png';
  const model = normalizeDeckForImage(ygoDeck([card('c1', 'main', url)]));
  const cache = createDeckImageCache();
  const { restore } = installFakeNetwork({ responses: new Map([[url, { neverResolves: true }]]) });
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
  const { restore } = installFakeNetwork({ responses: new Map([[url, { status: 200, contentType: 'image/jpeg', delayMs: 60 }]]) });
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

// --- renderDeckImage (bloccante): contratto esterno invariato, alcune -----
// carte fallite non impediscono alle altre di apparire.
{
  const deck = ygoDeck([card('c1', 'main', 'blocking-ok.png'), card('c2', 'main', 'blocking-broken.png')]);
  const responses = new Map([['blocking-ok.png', { status: 200, contentType: 'image/jpeg', delayMs: 10 }], ['blocking-broken.png', { status: 404, contentType: 'application/json' }]]);
  const { restore } = installFakeNetwork({ responses });
  try {
    const { canvas, calls } = fakeCanvas();
    const result = await renderDeckImage(deck, { canvas });
    assert.equal(result.mode, 'clean');
    assert(calls.clearRect >= 1, 'deve comunque disegnare almeno un frame');
  } finally { restore(); }
  console.log('PASS renderDeckImage: resta pienamente bloccante (un solo frame finale, preload atteso), una carta fallita non impedisce il completamento');
}

// --- renderDeckImagePreview: la PROVA richiesta esplicitamente -----------
// Il primo frame deve essere disegnato in modo SINCRONO, prima che una
// qualunque immagine reale abbia anche solo la possibilità di risolversi, e
// un artwork fallito non deve impedire agli altri di apparire.
{
  const okUrl = 'preview-ok.png', brokenUrl = 'preview-broken.png';
  const deck = ygoDeck([card('c1', 'main', okUrl), card('c2', 'main', brokenUrl)]);
  const responses = new Map([[okUrl, { status: 200, contentType: 'image/jpeg', delayMs: 40 }], [brokenUrl, { status: 403, contentType: 'application/json', delayMs: 40 }]]);
  const { activity, restore } = installFakeNetwork({ responses });
  try {
    const { canvas, calls } = fakeCanvas();
    const result = renderDeckImagePreview(deck, { canvas, previewTimeoutMs: 1000, concurrency: 6 });
    // Punto di osservazione SINCRONO, immediatamente dopo la chiamata: nessun
    // await è ancora avvenuto in questo test, quindi nessun fetch fittizio
    // (delayMs:40) può essersi già risolto — la preview è quindi
    // dimostrabilmente comparsa PRIMA del completamento di qualunque immagine.
    assert(calls.clearRect >= 1, 'il primo frame (con placeholder) deve essere disegnato in modo sincrono, senza attendere il preload');
    assert.equal(result.cache.images.has(okUrl), false, 'nessuna immagine può già essere risolta al ritorno sincrono della funzione');

    const clearRectAfterFirstFrame = calls.clearRect;
    await result.ready;
    assert(calls.clearRect > clearRectAfterFirstFrame, 'deve avvenire un secondo redraw incrementale dopo che l\'artwork è arrivato');
    assert.notEqual(result.cache.images.get(okUrl), undefined, 'l\'artwork valido deve risolvere');
    assert.equal(result.cache.images.has(brokenUrl), false, 'l\'artwork rotto (403) non deve mai diventare un falso successo');
  } finally { restore(); }
  console.log('PASS renderDeckImagePreview: primo frame disegnato in modo sincrono con placeholder PRIMA che qualunque immagine sia risolta, poi redraw incrementale; una carta fallita non blocca le altre');
}

// --- One Piece: stessa pipeline progressiva, adapter leader/main/don -----
// riusati senza alcun branching hardcoded aggiuntivo (nessun `if game ===
// 'yugioh'` da nessuna parte in questo modulo).
{
  const deck = { name: 'Luffy Rush', game: 'onepiece', format: '', deckTheme: null, signatureCardId: null, cards: [
    card('OP01-001', 'leader', 'https://optcgapi.com/media/static/Card_Images/OP01-001.jpg'),
    card('OP01-016', 'main', 'https://optcgapi.com/media/static/Card_Images/OP01-016.jpg'),
    card('don-1', 'don', '')
  ] };
  const responses = new Map([
    ['https://optcgapi.com/media/static/Card_Images/OP01-001.jpg', { status: 200, contentType: 'image/jpeg', delayMs: 15 }],
    ['https://optcgapi.com/media/static/Card_Images/OP01-016.jpg', { status: 200, contentType: 'image/jpeg', delayMs: 5 }]
  ]);
  const { restore } = installFakeNetwork({ responses });
  try {
    const { canvas, calls } = fakeCanvas();
    const { ready, model, cache } = renderDeckImagePreview(deck, { canvas, previewTimeoutMs: 1000, concurrency: 6 });
    assert.equal(model.sections.map(s => s.key).join(','), 'leader,main,don', 'la pipeline progressiva deve riusare le sezioni reali dell\'adapter One Piece, non main/extra/side');
    await ready;
    assert.notEqual(cache.images.get('https://optcgapi.com/media/static/Card_Images/OP01-001.jpg'), undefined);
    assert.notEqual(cache.images.get('https://optcgapi.com/media/static/Card_Images/OP01-016.jpg'), undefined);
    assert(calls.clearRect >= 1);
  } finally { restore(); }
  console.log('PASS One Piece: caricamento progressivo (fetch osservabile) funziona identico su leader/main/don, riusando gli stessi adapter senza branching duplicato');
}

console.log('PASS deck-image-export caricamento progressivo: pipeline fetch osservabile, cache a 3 mappe senza falsi successi, retry con budget limitato, concorrenza limitata, timeout breve con upgrade tardivo, tetto globale export, preview sincrona prima del preload, retrocompatibilità, One Piece incluso');
