// Decklist Image Generator — indipendente dalla UI del Deck Builder (nessun
// import da decks.js, nessuna dipendenza dal DOM del deck editor). Riusa la
// canonicalizzazione carte/identity già esistente (canonicalCatalogCardId,
// preferredDeckArtwork, resolveDeckSignature, l'adapter sezioni/etichette
// per gioco) invece di reinventarla.
//
// Pipeline: normalizeDeckForImage() -> computeDeckImageLayout() (puro, solo
// numeri: nessun overflow per costruzione, testabile senza un canvas reale)
// -> preloadDeckImageAssets() -> drawDeckImage() su un canvas 1080x1350 reale
// -> exportDeckImageBlob()/downloadDeckImageBlob()/shareDeckImageBlob().
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
export function normalizeDeckForImage(deck, { ownerName = '' } = {}) {
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
    else bucket.set(id, { catalogCardId: id, cardName: card.cardName || '', imageUrl: preferredDeckArtwork(card) || card.imageUrl || '', quantity });
  }

  const sections = sectionKeys.map(key => ({ key, label: labels[key] || key, cards: [...(buckets.get(key)?.values() || [])] }));
  const sectionByKey = key => sections.find(section => section.key === key)?.cards || [];

  const signatureSource = resolveDeckSignature(deck);
  const signatureCard = signatureSource ? {
    catalogCardId: canonicalCatalogCardId(signatureSource.catalogCardId, game) || String(signatureSource.catalogCardId || ''),
    cardName: signatureSource.cardName || '',
    imageUrl: preferredDeckArtwork(signatureSource) || signatureSource.imageUrl || ''
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

// --- Layout puro ---------------------------------------------------------
// Nessun overflow per costruzione: la griglia usa un numero fisso di
// colonne e restringe le celle (mai i margini/il canvas) finché tutte le
// sezioni non entrano nell'altezza disponibile. Testabile senza un canvas
// reale: produce solo coordinate numeriche.
const PADDING = 56;
const HEADER_HEIGHT = 214;
const FOOTER_HEIGHT = 56;
const SECTION_TITLE_HEIGHT = 34;
const SECTION_GAP = 26;
const GRID_COLUMNS = 8;
const BASE_CELL_GAP = 14;
const CELL_ASPECT = 1.3; // altezza = larghezza * CELL_ASPECT

export function computeDeckImageLayout(model, { width = DECK_IMAGE_WIDTH, height = DECK_IMAGE_HEIGHT } = {}) {
  const contentX = PADDING;
  const contentWidth = width - PADDING * 2;
  const baseCellWidth = (contentWidth - (GRID_COLUMNS - 1) * BASE_CELL_GAP) / GRID_COLUMNS;
  const baseCellHeight = baseCellWidth * CELL_ASPECT;

  const nonEmpty = model.sections.filter(section => section.cards.length > 0);
  const rowsFor = section => Math.ceil(section.cards.length / GRID_COLUMNS);
  const blockHeightAt = (section, cellH, gap) => SECTION_TITLE_HEIGHT + rowsFor(section) * cellH + Math.max(0, rowsFor(section) - 1) * gap;

  const neededAtBase = nonEmpty.reduce((sum, section) => sum + blockHeightAt(section, baseCellHeight, BASE_CELL_GAP), 0)
    + Math.max(0, nonEmpty.length - 1) * SECTION_GAP;

  const availableHeight = height - PADDING - HEADER_HEIGHT - FOOTER_HEIGHT - PADDING;
  const scale = neededAtBase > availableHeight && neededAtBase > 0 ? availableHeight / neededAtBase : 1;

  const cellWidth = baseCellWidth * scale;
  const cellHeight = baseCellHeight * scale;
  const cellGap = BASE_CELL_GAP * scale;

  let cursorY = PADDING + HEADER_HEIGHT;
  const sections = [];
  nonEmpty.forEach((section, index) => {
    const titleY = cursorY;
    const gridY = titleY + SECTION_TITLE_HEIGHT;
    const cards = section.cards.map((card, cardIndex) => {
      const col = cardIndex % GRID_COLUMNS;
      const row = Math.floor(cardIndex / GRID_COLUMNS);
      return { ...card, x: contentX + col * (cellWidth + cellGap), y: gridY + row * (cellHeight + cellGap), w: cellWidth, h: cellHeight };
    });
    sections.push({ key: section.key, label: section.label, totalQuantity: sectionTotalQuantity(section.cards), titleX: contentX, titleY, cards });
    cursorY = gridY + rowsFor(section) * cellHeight + Math.max(0, rowsFor(section) - 1) * cellGap;
    if (index < nonEmpty.length - 1) cursorY += SECTION_GAP;
  });

  return {
    width, height, padding: PADDING,
    header: { x: contentX, y: PADDING, width: contentWidth, height: HEADER_HEIGHT },
    sections,
    footer: { x: contentX, y: height - PADDING - FOOTER_HEIGHT / 2, width: contentWidth }
  };
}

// --- Preload immagini ----------------------------------------------------
// Cache per-sessione (Map url->Image) passabile dal chiamante così più
// export/preview consecutivi sulla STESSA istanza di controller non
// riscaricano mai lo stesso artwork. Un timeout per immagine e un fallback
// a null (mai un throw): una card senza artwork non deve mai bloccare
// l'intero export.
export function createDeckImageCache() { return new Map(); }

function loadImage(url, { timeoutMs = 8000 } = {}) {
  return new Promise(resolve => {
    if (!url) { resolve(null); return; }
    const img = new Image();
    let settled = false;
    const finish = value => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => finish(null), timeoutMs);
    img.crossOrigin = 'anonymous';
    img.onload = () => finish(img);
    img.onerror = () => finish(null);
    img.src = url;
  });
}

function resolveAssetUrl(url, proxyUrl) {
  if (!url) return '';
  return proxyUrl ? `${proxyUrl}${proxyUrl.includes('?') ? '&' : '?'}url=${encodeURIComponent(url)}` : url;
}

export async function preloadDeckImageAssets(model, { proxyUrl = '', timeoutMs = 8000, cache = createDeckImageCache() } = {}) {
  const urls = new Set();
  for (const section of model.sections) for (const card of section.cards) if (card.imageUrl) urls.add(card.imageUrl);
  if (model.signatureCard?.imageUrl) urls.add(model.signatureCard.imageUrl);

  await Promise.all([...urls].filter(url => !cache.has(url)).map(async url => {
    const image = await loadImage(resolveAssetUrl(url, proxyUrl), { timeoutMs });
    cache.set(url, image);
  }));
  return cache;
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

export function drawDeckImage(ctx, model, layout, images, mode = 'clean') {
  const { width, height, padding } = layout;
  const accent = resolveImageAccent(model.theme);
  const useSignature = mode === 'signature' && model.signatureCard?.imageUrl;

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#0c0a10';
  ctx.fillRect(0, 0, width, height);

  if (useSignature) {
    const bg = images.get(model.signatureCard.imageUrl);
    if (bg) {
      ctx.save();
      ctx.filter = 'blur(14px) brightness(0.55)';
      drawCoverImage(ctx, bg, -20, -20, width + 40, height + 40);
      ctx.restore();
      ctx.fillStyle = 'rgba(12,10,16,0.62)';
      ctx.fillRect(0, 0, width, height);
    }
  }

  // Header
  const headerX = layout.header.x;
  let y = layout.header.y;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = accent;
  ctx.font = '700 24px "Segoe UI", sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('FPT CARDS', headerX, y + 24);
  if (model.owner) {
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.font = '600 22px "Segoe UI", sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(model.owner, headerX + layout.header.width, y + 24);
  }
  y += 56;
  ctx.fillStyle = '#ffffff';
  ctx.font = '800 52px "Segoe UI", sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(truncateToWidth(ctx, model.name, layout.header.width), headerX, y);
  y += 40;
  ctx.fillStyle = 'rgba(255,255,255,0.65)';
  ctx.font = '500 24px "Segoe UI", sans-serif';
  const subtitle = [GAME_LABELS[model.game] || model.game, model.format].filter(Boolean).join(' · ');
  ctx.fillText(subtitle, headerX, y);
  y += 24;
  ctx.strokeStyle = 'rgba(255,255,255,0.16)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(headerX, y);
  ctx.lineTo(headerX + layout.header.width, y);
  ctx.stroke();

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
      if (image) drawCoverImage(ctx, image, card.x, card.y, card.w, card.h);
      else drawPlaceholder(ctx, card.x, card.y, card.w, card.h);
      ctx.restore();
      drawQuantityBadge(ctx, card.quantity, card.x, card.y, card.w, card.h, accent);
    }
  }

  // Footer
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.font = '500 20px "Segoe UI", sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText('Made with FPT Cards', layout.footer.x + layout.footer.width, layout.footer.y);
}

function truncateToWidth(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let truncated = text;
  while (truncated.length > 1 && ctx.measureText(`${truncated}…`).width > maxWidth) truncated = truncated.slice(0, -1);
  return `${truncated}…`;
}

// --- Orchestrazione / export ---------------------------------------------
export async function renderDeckImage(deck, { mode = 'clean', ownerName = '', proxyUrl = '', cache, canvas } = {}) {
  const model = normalizeDeckForImage(deck, { ownerName });
  const effectiveMode = mode === 'signature' && model.signatureCard?.imageUrl ? 'signature' : 'clean';
  const layout = computeDeckImageLayout(model);
  const images = await preloadDeckImageAssets(model, { proxyUrl, cache });
  const target = canvas || (typeof document !== 'undefined' ? document.createElement('canvas') : null);
  if (!target) throw new Error('Canvas non disponibile in questo ambiente');
  target.width = DECK_IMAGE_WIDTH;
  target.height = DECK_IMAGE_HEIGHT;
  const ctx = target.getContext('2d');
  drawDeckImage(ctx, model, layout, images, effectiveMode);
  return { canvas: target, model, layout, mode: effectiveMode };
}

export function exportDeckImageBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error('Generazione PNG non riuscita'))), 'image/png');
  });
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
