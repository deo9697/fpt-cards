// Decklist Image Generator — indipendente dalla UI del Deck Builder (nessun
// import da decks.js, nessuna dipendenza dal DOM del deck editor). Riusa la
// canonicalizzazione carte/identity già esistente (canonicalCatalogCardId,
// resolveDeckSignature, l'adapter sezioni/etichette
// per gioco) invece di reinventarla.
//
// Pipeline: normalizeDeckForImage() -> computeDeckImageLayout() (puro, solo
// numeri: nessun overflow per costruzione, testabile senza un canvas reale)
// -> preloadDeckImagesProgressively() (concorrenza limitata, redraw
// incrementale via renderDeckImagePreview) o renderDeckImage() (bloccante,
// un solo draw finale) -> exportDeckImageBlob()/downloadDeckImageBlob()/
// shareDeckImageBlob().
import { canonicalCatalogCardId } from './cards.js';
import { preferredDeckArtwork, resolveDeckSignature, DECK_THEMES, normalizeDeckTheme } from './deck-box.js';
import { getGameAdapter } from './games/index.js';

export const DECK_IMAGE_WIDTH = 1080;
export const DECK_IMAGE_HEIGHT = 1350;

// --- Modello -----------------------------------------------------------
// Shape richiesta: {name, owner, game, format, signatureCard, theme, main,
// extra, side}. Le sezioni reali del gioco (sezioni/etichette dall'adapter,
// mai un elenco fisso — One Piece ha leader/main/don, non main/extra/side)
// vivono in `sections`; main/extra/side restano come viste di comodo sulle
// SOLE chiavi realmente presenti in quel gioco (mai un dato perso: ogni
// carta finisce sempre in `sections`, main/extra/side sono solo un alias).
export function normalizeDeckForImage(deck, { ownerName = '', cardTypes = {} } = {}) {
  const game = deck?.game || 'yugioh';
  const adapter = getGameAdapter(game);
  const sectionKeys = adapter.sections || ['main'];
  const labels = adapter.labels || {};
  const buckets = new Map(sectionKeys.map(key => [key, new Map()]));

  for (const card of deck?.cards || []) {
    const bucket = buckets.get(card?.section) || buckets.get(sectionKeys[0]);
    if (!bucket) continue;
    const id = canonicalCatalogCardId(card.catalogCardId, game) || String(card.catalogCardId || '').trim();
    if (!id) continue;
    const quantity = Math.max(1, Number(card.quantity) || 1);
    const existing = bucket.get(id);
    if (existing) existing.quantity += quantity;
    else bucket.set(id, { catalogCardId: id, cardName: card.cardName || '', imageUrl: card.imageUrl || card.croppedImageUrl || '', cardType:cardTypes[card.catalogCardId] || cardTypes[id] || card.cardType || card.type || '', quantity });
  }

  const sections = sectionKeys.map(key => ({ key, label: labels[key] || key, cards: [...(buckets.get(key)?.values() || [])] }));
  if (game === 'yugioh') {
    const rank = card => {
      const type = String(card.cardType || '').toLowerCase();
      return type.includes('monster') ? 0 : type.includes('spell') ? 1 : type.includes('trap') ? 2 : 3;
    };
    for (const section of sections) section.cards.sort((a,b) => rank(a)-rank(b));
  }
  const sectionByKey = key => sections.find(section => section.key === key)?.cards || [];

  const signatureSource = resolveDeckSignature(deck);
  const signatureCard = signatureSource ? {
    catalogCardId: canonicalCatalogCardId(signatureSource.catalogCardId, game) || String(signatureSource.catalogCardId || ''),
    cardName: signatureSource.cardName || '',
    imageUrl: signatureSource.imageUrl || signatureSource.croppedImageUrl || ''
  } : null;

  return {
    name: deck?.name || 'Mazzo senza nome',
    owner: ownerName || deck?.ownerName || '',
    game,
    format: deck?.format || '',
    signatureCard,
    theme: deck?.deckTheme || null,
    sections,
    main: sectionByKey('main'),
    extra: sectionByKey('extra'),
    side: sectionByKey('side')
  };
}

export function sectionTotalQuantity(cards = []) {
  return cards.reduce((sum, card) => sum + (Number(card.quantity) || 0), 0);
}

// --- Tema --------------------------------------------------------------
// Riuso conservativo di DECK_THEMES (js/deck-box.js, tabella piatta nome->
// colori, mai modificata): se il tema del mazzo risolve a qualcosa di noto
// se ne prende solo l'accento, mai l'intero sistema Deck Box. Se manca o
// non risolve, palette FPT fissa — il renderer resta pronto a ricevere un
// theme object più ricco in futuro senza cambiare la sua firma.
const FALLBACK_THEME = { accent: '#eebd54', dark: '#0c0a10' };
export function resolveImageAccent(theme) {
  const resolved = DECK_THEMES[normalizeDeckTheme(theme)];
  return resolved?.accent || FALLBACK_THEME.accent;
}

// --- Layout puro (V1.1) ---------------------------------------------------
// Nessun overflow per costruzione: ogni griglia restringe le proprie celle
// (mai i margini/il canvas) finché entra nel budget di altezza assegnato.
// Testabile senza un canvas reale: produce solo coordinate numeriche.
//
// V1.1 rende il Main dominante invece di condividere UNA griglia uniforme
// con Extra/Side: Main sceglie tra 4-10 colonne (6-8 il caso comune per un
// mazzo tipico, mai fissa a 8 come in V1), le sezioni "compatte" (Extra/
// Side/DON!! — tutto ciò che non è Main) tra 9-12, sempre più dense/piccole
// del Main anche quando avanza altezza (COMPACT_MAX_WIDTH_RATIO). Il Leader
// (One Piece) riceve una cornice dedicata più grande SOLO in Poster Mode —
// in Readable resta una sezione compatta come le altre, nessuna gerarchia
// visiva aggiuntiva. Nessun branching per gioco: si basa solo sulle CHIAVI
// di sezione già fornite dall'adapter (main/leader), le stesse per
// entrambi i giochi.
const PADDING = 56;
const SECTION_TITLE_HEIGHT = 34;
const SECTION_GAP = 20;
const BASE_CELL_GAP = 10;
const CELL_ASPECT = 1.46;
const MAIN_COLUMNS_CANDIDATES = [4, 5, 6, 7, 8, 9, 10];
const COMPACT_COLUMNS_CANDIDATES = [9, 10, 11, 12];
const LEADER_COLUMNS_CANDIDATES = [2, 3];
const COMPACT_MAX_WIDTH_RATIO = 0.85;
const LEADER_MAX_HEIGHT_SHARE = 0.28;
const LAYOUT_PRESETS = {
  // Priorità massima alla leggibilità: header/footer più sobri (meno spazio
  // decorativo) e una quota maggiore dell'altezza riservata al Main così le
  // sue card crescono di più.
  readable: { headerHeight: 172, footerHeight: 30, mainHeightShare: 0.66 },
  // Più scenico (spazio per firma/branding), quota Main leggermente minore
  // e il Leader (One Piece) ottiene una cornice dedicata più grande.
  poster: { headerHeight: 194, footerHeight: 40, mainHeightShare: 0.60 }
};

// `rowsForColumns(columns)` — MAI un semplice ceil(cardCount/columns) quando
// il candidato copre PIÙ sezioni compatte (Extra+Side, o Extra+Side+DON!!):
// ognuna arrotonda le proprie righe per conto suo a rendering (ogni sezione
// è un blocco a sé, con un proprio inizio riga), quindi il budget deve
// sommare i ceil PER SEZIONE — un ceil unico sul totale delle carte
// sottostima le righe reali (bug reale, trovato testando l'overflow su
// 40 main / 15 extra / 15 side) e produce un cellWidth troppo grande che
// esce dal canvas una volta sommate le sezioni davvero renderizzate.
function bestGridFor(rowsForColumns, columnsCandidates, availableHeight, contentWidth) {
  let best = null;
  for (const columns of columnsCandidates) {
    const baseWidth = (contentWidth - (columns - 1) * BASE_CELL_GAP) / columns;
    const rows = Math.max(1, rowsForColumns(columns));
    const neededHeight = rows * baseWidth * CELL_ASPECT + Math.max(0, rows - 1) * BASE_CELL_GAP;
    const scale = neededHeight > 0 ? Math.min(1, Math.max(0, availableHeight / neededHeight)) : 1;
    const candidate = { columns, cellWidth: baseWidth * scale, cellGap: BASE_CELL_GAP * scale, rows };
    if (!best || candidate.cellWidth > best.cellWidth) best = candidate;
  }
  return best;
}
const rowsForSingleSection = cardCount => columns => Math.ceil(cardCount / columns);
const rowsForMultipleSections = sections => columns => sections.reduce((sum, section) => sum + Math.ceil(section.cards.length / columns), 0);

export function computeDeckImageLayout(model, { width = DECK_IMAGE_WIDTH, height = DECK_IMAGE_HEIGHT, layoutMode = 'readable' } = {}) {
  const preset = LAYOUT_PRESETS[layoutMode] || LAYOUT_PRESETS.readable;
  const { headerHeight, footerHeight, mainHeightShare } = preset;
  const contentX = PADDING;
  const contentWidth = width - PADDING * 2;
  const nonEmpty = model.sections.filter(section => section.cards.length > 0);
  const fixedHeight = nonEmpty.length * SECTION_TITLE_HEIGHT + Math.max(0, nonEmpty.length - 1) * SECTION_GAP;
  const availableCardsHeight = Math.max(0, height - PADDING - headerHeight - footerHeight - PADDING - fixedHeight);

  const mainSection = nonEmpty.find(section => section.key === 'main') || null;
  const leaderSection = layoutMode === 'poster' ? (nonEmpty.find(section => section.key === 'leader') || null) : null;
  const otherSections = nonEmpty.filter(section => section !== mainSection && section !== leaderSection);
  const otherCardCount = otherSections.reduce((sum, section) => sum + section.cards.length, 0);

  let leaderGrid = null, leaderBudget = 0;
  if (leaderSection) {
    const rowsForLeader = rowsForSingleSection(leaderSection.cards.length);
    const probe = bestGridFor(rowsForLeader, LEADER_COLUMNS_CANDIDATES, availableCardsHeight, contentWidth);
    const neededHeight = probe.rows * probe.cellWidth * CELL_ASPECT + Math.max(0, probe.rows - 1) * probe.cellGap;
    leaderBudget = Math.min(availableCardsHeight * LEADER_MAX_HEIGHT_SHARE, neededHeight);
    leaderGrid = bestGridFor(rowsForLeader, LEADER_COLUMNS_CANDIDATES, leaderBudget, contentWidth);
  }
  const remainingAfterLeader = Math.max(0, availableCardsHeight - leaderBudget);

  let mainGrid = null, compactGrid = null;
  if (mainSection && otherSections.length) {
    const mainBudget = remainingAfterLeader * mainHeightShare;
    mainGrid = bestGridFor(rowsForSingleSection(mainSection.cards.length), MAIN_COLUMNS_CANDIDATES, mainBudget, contentWidth);
    const mainUsedHeight = mainGrid.rows * mainGrid.cellWidth * CELL_ASPECT + Math.max(0, mainGrid.rows - 1) * mainGrid.cellGap;
    // Il Main non usa tutto il proprio budget (poche carte uniche): l'altezza
    // avanzata torna alle sezioni compatte invece di restare vuota.
    const compactBudget = Math.max(0, remainingAfterLeader - mainBudget) + Math.max(0, mainBudget - mainUsedHeight);
    compactGrid = bestGridFor(rowsForMultipleSections(otherSections), COMPACT_COLUMNS_CANDIDATES, compactBudget, contentWidth);
    if (compactGrid.cellWidth > mainGrid.cellWidth * COMPACT_MAX_WIDTH_RATIO) {
      const cappedWidth = mainGrid.cellWidth * COMPACT_MAX_WIDTH_RATIO;
      compactGrid = { ...compactGrid, cellWidth: cappedWidth, cellGap: compactGrid.cellGap * (cappedWidth / compactGrid.cellWidth) };
    }
  } else if (mainSection) {
    mainGrid = bestGridFor(rowsForSingleSection(mainSection.cards.length), MAIN_COLUMNS_CANDIDATES, remainingAfterLeader, contentWidth);
  } else if (otherSections.length) {
    compactGrid = bestGridFor(rowsForMultipleSections(otherSections), COMPACT_COLUMNS_CANDIDATES, remainingAfterLeader, contentWidth);
  }

  const gridFor = section => section === mainSection ? mainGrid : section === leaderSection ? leaderGrid : compactGrid;
  // Il Leader va sempre per primo quando presente (enfasi visiva in cima al
  // poster); le altre sezioni restano nell'ordine dato dall'adapter.
  const ordered = leaderSection ? [leaderSection, ...nonEmpty.filter(section => section !== leaderSection)] : nonEmpty;

  let cursorY = PADDING + headerHeight;
  const sections = [];
  ordered.forEach((section, index) => {
    const grid = gridFor(section);
    const { columns, cellWidth, cellGap } = grid;
    const cellHeight = cellWidth * CELL_ASPECT;
    const rows = Math.max(1, Math.ceil(section.cards.length / columns));
    const gridX = contentX + (contentWidth - columns * cellWidth - (columns - 1) * cellGap) / 2;
    const titleY = cursorY;
    const gridY = titleY + SECTION_TITLE_HEIGHT;
    const cards = section.cards.map((card, cardIndex) => {
      const col = cardIndex % columns;
      const row = Math.floor(cardIndex / columns);
      return { ...card, x: gridX + col * (cellWidth + cellGap), y: gridY + row * (cellHeight + cellGap), w: cellWidth, h: cellHeight };
    });
    sections.push({ key: section.key, label: section.label, totalQuantity: sectionTotalQuantity(section.cards), titleX: gridX, titleY, cards, dominant: section === mainSection, hero: section === leaderSection });
    cursorY = gridY + rows * cellHeight + Math.max(0, rows - 1) * cellGap;
    if (index < ordered.length - 1) cursorY += SECTION_GAP;
  });

  return {
    width, height, padding: PADDING, layoutMode,
    header: { x: contentX, y: PADDING, width: contentWidth, height: headerHeight },
    sections,
    footer: { x: contentX, y: height - PADDING - footerHeight / 2, width: contentWidth }
  };
}

// --- Preload immagini (progressivo) --------------------------------------
// Cache per-sessione passabile dal chiamante così più export/preview
// consecutivi sulla STESSA istanza di controller non riscaricano mai
// l'artwork già risolto con successo:
// {images}: url->HTMLImageElement SOLO per un caricamento riuscito davvero
//   (mai null: un fallimento non finisce mai qui, altrimenti diventerebbe un
//   "successo" permanente e nessun retry sarebbe più possibile — bug reale
//   corretto qui, la causa esatta dei placeholder permanenti in produzione).
// {inFlight}: url->Promise del caricamento REALE ancora in corso, usata sia
//   per deduplicare richieste concorrenti alla stessa URL sia da
//   waitForPendingDeckImages() a export-time.
// {failures}: url->{count, reason} per i soli fallimenti, con un budget di
//   retry limitato (DEFAULT_MAX_ATTEMPTS) — mai un loop infinito, mai più di
//   maxAttempts fetch reali per URL nella vita della cache.
export function createDeckImageCache() { return { images: new Map(), inFlight: new Map(), failures: new Map() }; }

export const DEFAULT_PREVIEW_CONCURRENCY = 8;
export const DEFAULT_PREVIEW_TIMEOUT_MS = 2500;
export const DEFAULT_EXPORT_TIMEOUT_MS = 6000;
export const DEFAULT_MAX_ATTEMPTS = 2;

function resolveAssetUrl(url, proxyUrl) {
  if (!url) return '';
  // Local artwork and blob URLs are already canvas-safe; the remote proxy
  // only accepts absolute URLs on its allowlist.
  if (!/^https?:\/\//i.test(url)) return url;
  if (typeof location !== 'undefined' && new URL(url).origin === location.origin) return url;
  return proxyUrl ? `${proxyUrl}${proxyUrl.includes('?') ? '&' : '?'}url=${encodeURIComponent(url)}` : url;
}

// Log sintetico SOLO in ambienti di sviluppo (localhost/127.0.0.1 o
// window.FPT_CONFIG.debug esplicito), mai in produzione: nessun dato
// sensibile, solo URL pubbliche di artwork e lo stato HTTP osservato.
function isDevEnvironment() {
  try { return typeof window !== 'undefined' && (window.FPT_CONFIG?.debug === true || ['localhost', '127.0.0.1'].includes(window.location?.hostname)); }
  catch { return false; }
}
function logArtworkFailure(diagnostic, attempt, maxAttempts) {
  if (!isDevEnvironment()) return;
  console.warn('[deck-image-export] artwork non caricato', { ...diagnostic, attempt, maxAttempts });
}

// Carica un blob già scaricato in un <img>, aspettando la decodifica
// completa (decode(), quando disponibile) PRIMA di revocare l'Object URL:
// una volta decodificato il bitmap resta valido per tutti i disegni futuri
// del canvas, l'Object URL non serve più. Se decode() non è disponibile
// (ambiente senza supporto) ricade su onload/onerror.
async function decodeImageFromBlob(blob) {
  const objectUrl = URL.createObjectURL(blob);
  const img = new Image();
  img.src = objectUrl;
  try {
    if (typeof img.decode === 'function') await img.decode();
    else await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = () => reject(new Error('decode-error')); });
    return img;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

// Caricamento REALE tramite fetch osservabile (mai un <img src> "cieco"
// puntato direttamente sul proxy): questo è l'unico modo per distinguere
// davvero un successo da uno stato HTTP/rete specifico (403 whitelist, 404
// carta assente, 502 upstream irraggiungibile, content-type non-immagine,
// errore di rete) invece di un generico onerror senza alcuna informazione.
// Non lancia mai: un fallimento risolve sempre a {image:null, diagnostic}.
async function loadArtwork(originalUrl, proxyUrl) {
  const resolvedUrl = resolveAssetUrl(originalUrl, proxyUrl);
  const diagnostic = { originalUrl, resolvedUrl, status: null, contentType: null, reason: '' };
  if (!originalUrl) { diagnostic.reason = 'no-url'; return { image: null, diagnostic }; }

  let response;
  try { response = await fetch(resolvedUrl, { signal: AbortSignal.timeout(12000) }); }
  catch { diagnostic.reason = 'network-error'; return { image: null, diagnostic }; }

  diagnostic.status = response.status;
  diagnostic.contentType = response.headers.get('content-type') || '';
  if (!response.ok) { diagnostic.reason = `http-${response.status}`; return { image: null, diagnostic }; }
  if (!diagnostic.contentType.startsWith('image/')) { diagnostic.reason = 'not-an-image'; return { image: null, diagnostic }; }

  let blob;
  try { blob = await response.blob(); }
  catch { diagnostic.reason = 'blob-error'; return { image: null, diagnostic }; }

  try { return { image: await decodeImageFromBlob(blob), diagnostic }; }
  catch { diagnostic.reason = 'decode-error'; return { image: null, diagnostic }; }
}

// Non rigetta e non annulla `promise`: si limita a "dare per persa
// l'attesa" dopo timeoutMs, restituendo un segnale distinto ({timedOut:true})
// così il chiamante può liberare uno slot di concorrenza o proseguire con un
// placeholder SENZA smettere di ascoltare l'esito reale, che potrà ancora
// arrivare più tardi.
function raceWithTimeout(promise, timeoutMs) {
  return new Promise(resolve => {
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; resolve({ timedOut: true }); } }, timeoutMs);
    promise.then(value => { if (!settled) { settled = true; clearTimeout(timer); resolve({ timedOut: false, value }); } });
  });
}

export function resolveDeckImageUrls(model) {
  const seen = new Set();
  const urls = [];
  const add = url => { if (url && !seen.has(url)) { seen.add(url); urls.push(url); } };
  for (const section of model.sections) for (const card of section.cards) add(card.imageUrl);
  add(model.signatureCard?.imageUrl);
  return urls;
}

function isRetryExhausted(cache, url, maxAttempts) {
  const entry = cache.failures.get(url);
  return !!entry && entry.count >= maxAttempts;
}

// Coda con concorrenza limitata (6-8 richieste attive, mai tutte insieme):
// ogni worker processa un URL alla volta, con un timeout BREVE (previewTimeoutMs)
// che libera lo slot per il prossimo URL in coda senza mai annullare il
// caricamento reale — se questo arriva più tardi (dopo che il worker è già
// passato oltre), il .then agganciato all'avvio dell'immagine scrive
// comunque in cache.images e richiama onImageSettled (redraw incrementale,
// "upgrade tardivo" da placeholder ad artwork reale). Un successo non viene
// mai ripetuto; un fallimento con budget di retry residuo viene rimesso in
// coda (via retryQueue) per un secondo tentativo nella stessa chiamata.
async function runDeckImagePool(urls, { proxyUrl, cache, concurrency, previewTimeoutMs, maxAttempts, onImageSettled, retryQueue }) {
  const queue = urls.slice();
  async function worker() {
    while (queue.length) {
      const url = queue.shift();
      if (cache.images.has(url)) continue; // risolta nel frattempo da un altro worker/upgrade tardivo
      let realPromise = cache.inFlight.get(url);
      if (!realPromise) {
        realPromise = loadArtwork(url, proxyUrl);
        cache.inFlight.set(url, realPromise);
        realPromise.then(({ image, diagnostic }) => {
          cache.inFlight.delete(url);
          if (image) {
            cache.images.set(url, image);
            cache.failures.delete(url); // un successo azzera lo storico di fallimenti precedenti
          } else {
            const count = (cache.failures.get(url)?.count || 0) + 1;
            cache.failures.set(url, { count, reason: diagnostic.reason });
            logArtworkFailure(diagnostic, count, maxAttempts);
            if (count < maxAttempts) retryQueue?.push(url);
          }
          onImageSettled?.(url, image, diagnostic);
        });
      }
      await raceWithTimeout(realPromise, previewTimeoutMs); // libera lo slot indipendentemente dall'esito
    }
  }
  const effectiveConcurrency = Math.max(1, Math.min(concurrency, queue.length || 1));
  await Promise.all(Array.from({ length: effectiveConcurrency }, worker));
}

export async function preloadDeckImagesProgressively(model, {
  proxyUrl = '', cache = createDeckImageCache(),
  concurrency = DEFAULT_PREVIEW_CONCURRENCY, previewTimeoutMs = DEFAULT_PREVIEW_TIMEOUT_MS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS, onImageSettled
} = {}) {
  const urls = resolveDeckImageUrls(model).filter(url => !cache.images.has(url) && !isRetryExhausted(cache, url, maxAttempts));
  const retryQueue = [];
  await runDeckImagePool(urls, { proxyUrl, cache, concurrency, previewTimeoutMs, maxAttempts, onImageSettled, retryQueue });
  // Una sola ondata di retry per chiamata (budget di default: 1 tentativo +
  // 1 retry = DEFAULT_MAX_ATTEMPTS): mai un terzo giro qui, mai un loop
  // interno illimitato. Un ulteriore tentativo, se il budget lo permette
  // ancora, avviene solo su una successiva invocazione esplicita (nuova
  // apertura preview, cambio modalità), MAI spam automatico.
  if (retryQueue.length) await runDeckImagePool(retryQueue, { proxyUrl, cache, concurrency, previewTimeoutMs, maxAttempts, onImageSettled });
  return cache;
}

// Usata SOLO a export-time: aspetta le sole richieste ancora realmente
// pendenti (cache.inFlight — quelle già risolte non vengono toccate) fino a
// un tetto globale ragionevole, poi restituisce il controllo comunque
// (mai un throw): il chiamante procede con un ultimo redraw e l'export,
// placeholder per chi non ce l'ha fatta in tempo.
export async function waitForPendingDeckImages(cache, { timeoutMs = DEFAULT_EXPORT_TIMEOUT_MS } = {}) {
  if (!cache.inFlight.size) return;
  await raceWithTimeout(Promise.allSettled([...cache.inFlight.values()]), timeoutMs);
}

// --- Disegno ---------------------------------------------------------
function roundedRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function drawCoverImage(ctx, image, x, y, w, h) {
  if (!image) return;
  const scale = Math.max(w / image.width, h / image.height);
  const drawW = image.width * scale, drawH = image.height * scale;
  ctx.drawImage(image, x + (w - drawW) / 2, y + (h - drawH) / 2, drawW, drawH);
}

function drawPlaceholder(ctx, x, y, w, h) {
  ctx.save();
  ctx.fillStyle = '#1c1826';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = 'rgba(255,255,255,0.14)';
  ctx.lineWidth = 2;
  ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
  ctx.restore();
}

function drawQuantityBadge(ctx, quantity, x, y, w, h, accent) {
  if (quantity <= 1) return;
  const size = Math.max(22, Math.min(w, h) * 0.3);
  const cx = x + w - size / 2 - 6, cy = y + h - size / 2 - 6;
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, size / 2, 0, Math.PI * 2);
  ctx.fillStyle = accent;
  ctx.fill();
  ctx.fillStyle = '#0c0a10';
  ctx.font = `700 ${Math.round(size * 0.5)}px "Segoe UI", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`×${quantity}`, cx, cy + 1);
  ctx.restore();
}

const GAME_LABELS = { yugioh: 'Yu-Gi-Oh!', onepiece: 'One Piece' };

// background: 'clean' | 'signature' | 'theme' — Signature/Theme riusano
// rispettivamente la carta signature già esistente (resolveDeckSignature) e
// la palette DECK_THEMES già esistente (js/deck-box.js, mai duplicata): un
// tema non genera mai un colore nuovo, solo una lettura diversa degli stessi
// accent/dark già usati dal Deck Box. logo: 'fpt' | 'none' — nessun upload,
// solo un interruttore per il branding testuale già presente in V1; la
// predisposizione per un logo custom futuro è che questa è l'UNICA riga che
// dovrebbe cambiare per disegnarne uno al posto del testo.
export function drawDeckImage(ctx, model, layout, images, { background = 'clean', layoutMode = 'readable', logo = 'fpt' } = {}) {
  const { width, height, padding } = layout;
  const accent = resolveImageAccent(model.theme);
  const themeColors = DECK_THEMES[normalizeDeckTheme(model.theme)] || {};
  const readable = layoutMode !== 'poster';
  const useSignature = background === 'signature' && model.signatureCard?.imageUrl;
  const useThemeBackground = background === 'theme';

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#0c0a10';
  ctx.fillRect(0, 0, width, height);

  if (useThemeBackground) {
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, themeColors.dark || '#0c0a10');
    gradient.addColorStop(1, '#0c0a10');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
  }

  if (useSignature) {
    const bg = images.get(model.signatureCard.imageUrl);
    if (bg) {
      ctx.save();
      // Readable resta sobrio anche con uno sfondo firmato: sfocatura più
      // forte e overlay più opaco, così il testo/le card restano sempre il
      // primo piano leggibile invece dello sfondo scenico.
      ctx.filter = readable ? 'blur(20px) brightness(0.38)' : 'blur(14px) brightness(0.55)';
      drawCoverImage(ctx, bg, -20, -20, width + 40, height + 40);
      ctx.restore();
      ctx.fillStyle = readable ? 'rgba(12,10,16,0.8)' : 'rgba(12,10,16,0.62)';
      ctx.fillRect(0, 0, width, height);
    }
  }

  ctx.fillStyle = accent;
  ctx.fillRect(padding, 26, width - padding * 2, 3);

  // Header
  const headerX = layout.header.x;
  let y = layout.header.y;
  ctx.textBaseline = 'alphabetic';
  if (logo !== 'none') {
    ctx.fillStyle = accent;
    ctx.font = '700 24px "Segoe UI", sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('FPT CARDS', headerX, y + 24);
  }
  if (model.owner) {
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.font = '600 22px "Segoe UI", sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(truncateToWidth(ctx, model.owner, layout.header.width * 0.6), headerX + layout.header.width, y + 24);
  }
  y += 78;
  ctx.fillStyle = '#ffffff';
  ctx.font = '800 48px "Segoe UI", sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(truncateToWidth(ctx, model.name, layout.header.width), headerX, y);
  y += 40;
  ctx.fillStyle = 'rgba(255,255,255,0.65)';
  ctx.font = '500 24px "Segoe UI", sans-serif';
  const subtitle = [GAME_LABELS[model.game] || model.game, model.format].filter(Boolean).join(' · ');
  ctx.fillText(truncateToWidth(ctx, subtitle, layout.header.width), headerX, y);
  y += 24;
  ctx.strokeStyle = 'rgba(255,255,255,0.16)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(headerX, y);
  ctx.lineTo(headerX + layout.header.width, y);
  ctx.stroke();
  ctx.fillStyle = accent;
  ctx.font = '600 19px "Segoe UI", sans-serif';
  ctx.fillText(model.sections.map(section => `${sectionTotalQuantity(section.cards)} ${section.label}`).join('   /   '), headerX, y + 36);

  // Sezioni
  for (const section of layout.sections) {
    ctx.fillStyle = accent;
    ctx.font = '700 22px "Segoe UI", sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`${section.label.toUpperCase()} · ${section.totalQuantity}`, section.titleX, section.titleY + SECTION_TITLE_HEIGHT - 10);
    for (const card of section.cards) {
      const image = images.get(card.imageUrl);
      roundedRect(ctx, card.x, card.y, card.w, card.h, 8);
      ctx.save();
      ctx.clip();
      if (image) {
        ctx.fillStyle = '#090b12';
        ctx.fillRect(card.x, card.y, card.w, card.h);
        const scale = Math.min(card.w / image.width, card.h / image.height);
        const w = image.width * scale, h = image.height * scale;
        ctx.drawImage(image, card.x + (card.w-w)/2, card.y + (card.h-h)/2, w, h);
      }
      else {
        drawPlaceholder(ctx, card.x, card.y, card.w, card.h);
        ctx.fillStyle = '#c4bacf';
        ctx.font = `500 ${Math.max(9,card.w * 0.11)}px "Segoe UI", sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText(truncateToWidth(ctx, card.cardName || 'Immagine assente', card.w - 10), card.x + card.w/2, card.y + card.h/2);
      }
      ctx.restore();
      if (section.hero) {
        ctx.save();
        ctx.strokeStyle = accent;
        ctx.lineWidth = 3;
        roundedRect(ctx, card.x + 1.5, card.y + 1.5, card.w - 3, card.h - 3, 8);
        ctx.stroke();
        ctx.restore();
      }
      drawQuantityBadge(ctx, card.quantity, card.x, card.y, card.w, card.h, accent);
    }
  }

  // Footer
  if (logo !== 'none') {
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = '500 20px "Segoe UI", sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText('Made with FPT Cards', layout.footer.x + layout.footer.width, layout.footer.y);
  }
}

function truncateToWidth(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let truncated = text;
  while (truncated.length > 1 && ctx.measureText(`${truncated}…`).width > maxWidth) truncated = truncated.slice(0, -1);
  return `${truncated}…`;
}

// --- Orchestrazione / export ---------------------------------------------
function prepareCanvasTarget(canvas) {
  const target = canvas || (typeof document !== 'undefined' ? document.createElement('canvas') : null);
  if (!target) throw new Error('Canvas non disponibile in questo ambiente');
  target.width = DECK_IMAGE_WIDTH;
  target.height = DECK_IMAGE_HEIGHT;
  return target;
}

// Contratto esterno invariato (fully blocking, un solo draw finale): usata
// dagli export/download esistenti e dai test già presenti. Internamente ora
// si appoggia al loader progressivo, ma attende SEMPRE il preload completo
// prima di disegnare — nessun placeholder visibile a chi chiama questa
// funzione, a differenza di renderDeckImagePreview qui sotto.
// mode: 'clean' | 'signature' | 'theme' (background). 'signature' ricade su
// 'clean' quando il mazzo non ha una signature card con artwork — stesso
// fallback automatico già presente in V1, mai un frame rotto.
function resolveEffectiveMode(mode, model) {
  if (mode === 'signature') return model.signatureCard?.imageUrl ? 'signature' : 'clean';
  if (mode === 'theme') return 'theme';
  return 'clean';
}

export async function renderDeckImage(deck, { mode = 'clean', layoutMode = 'readable', logo = 'fpt', ownerName = '', cardTypes = {}, proxyUrl = '', cache = createDeckImageCache(), canvas } = {}) {
  const model = normalizeDeckForImage(deck, { ownerName, cardTypes });
  const effectiveMode = resolveEffectiveMode(mode, model);
  const layout = computeDeckImageLayout(model, { layoutMode });
  // Il pool progressivo libera uno slot dopo previewTimeoutMs anche se il
  // caricamento reale non è ancora finito (per definizione, serve alla
  // concorrenza). Qui però il contratto è bloccante: dopo il pool si
  // aspettano ancora le eventuali richieste rimaste in cache.inFlight,
  // entro un tetto ragionevole, prima di disegnare una sola volta.
  await preloadDeckImagesProgressively(model, { proxyUrl, cache, concurrency: DEFAULT_PREVIEW_CONCURRENCY, previewTimeoutMs: DEFAULT_PREVIEW_TIMEOUT_MS });
  await waitForPendingDeckImages(cache, { timeoutMs: DEFAULT_EXPORT_TIMEOUT_MS });
  const target = prepareCanvasTarget(canvas);
  const ctx = target.getContext('2d');
  drawDeckImage(ctx, model, layout, cache.images, { background: effectiveMode, layoutMode, logo });
  return { canvas: target, model, layout, mode: effectiveMode, layoutMode };
}

// Percorso non bloccante per la preview UI: disegna SUBITO (sincrono, con
// quel che è già in cache — placeholder per tutto il resto), poi avvia il
// preload progressivo IN BACKGROUND (senza mai attenderlo qui) e ridisegna
// via onImageSettled ogni volta che un artwork arriva, incluse le eventuali
// risoluzioni tardive di richieste andate in timeout durante la preview.
// La promise `ready` nel valore di ritorno permette comunque a chi chiama
// di sapere quando il preload è terminato, se serve.
export function renderDeckImagePreview(deck, {
  mode = 'clean', layoutMode = 'readable', logo = 'fpt', ownerName = '', cardTypes = {}, proxyUrl = '', cache = createDeckImageCache(), canvas,
  concurrency = DEFAULT_PREVIEW_CONCURRENCY, previewTimeoutMs = DEFAULT_PREVIEW_TIMEOUT_MS, onProgress
} = {}) {
  const model = normalizeDeckForImage(deck, { ownerName, cardTypes });
  const effectiveMode = resolveEffectiveMode(mode, model);
  const layout = computeDeckImageLayout(model, { layoutMode });
  const target = prepareCanvasTarget(canvas);
  const ctx = target.getContext('2d');

  const redraw = () => drawDeckImage(ctx, model, layout, cache.images, { background: effectiveMode, layoutMode, logo });
  redraw(); // primo frame immediato, con placeholder per ogni artwork non ancora in cache

  const ready = preloadDeckImagesProgressively(model, {
    proxyUrl, cache, concurrency, previewTimeoutMs,
    onImageSettled: (url, image) => { redraw(); onProgress?.(url, image); }
  }).then(() => { redraw(); });
  cache.ready = ready;

  return { canvas: target, model, layout, mode: effectiveMode, layoutMode, cache, ready };
}

export function exportDeckImageBlob(canvas, { cache, model, layout, mode, layoutMode = 'readable', logo = 'fpt', exportTimeoutMs = DEFAULT_EXPORT_TIMEOUT_MS } = {}) {
  return (async () => {
    // inFlight alone omits URLs still waiting in the worker queue.
    if (cache?.ready) await raceWithTimeout(cache.ready, Math.max(exportTimeoutMs, 30000));
    if (cache?.inFlight?.size) {
      await waitForPendingDeckImages(cache, { timeoutMs: exportTimeoutMs });
      if (model && layout) drawDeckImage(canvas.getContext('2d'), model, layout, cache.images, { background: mode, layoutMode, logo });
    }
    return new Promise((resolve, reject) => {
      canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error('Generazione PNG non riuscita'))), 'image/png');
    });
  })();
}

export function sanitizeDeckFileNamePart(name) {
  return String(name || 'mazzo')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'mazzo';
}
export function deckImageFileName(deckName) { return `fpt-deck-${sanitizeDeckFileNamePart(deckName)}.png`; }

export function downloadDeckImageBlob(blob, deckName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = deckImageFileName(deckName);
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function canShareDeckImageBlob(blob, deckName) {
  if (typeof navigator === 'undefined' || !navigator.share || !navigator.canShare) return false;
  try {
    const file = new File([blob], deckImageFileName(deckName), { type: 'image/png' });
    return navigator.canShare({ files: [file] });
  } catch { return false; }
}

export async function shareDeckImageBlob(blob, deckName, { title = '' } = {}) {
  const file = new File([blob], deckImageFileName(deckName), { type: 'image/png' });
  await navigator.share({ files: [file], title: title || deckName });
}
