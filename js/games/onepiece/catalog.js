// Fase 4: il catalogo One Piece vive in Supabase (card_printings, popolato
// da supabase/functions/onepiece-catalog-sync), non più su OPTCG live —
// niente più tripla chiamata OPTCG ad ogni ricerca dell'utente. OPTCG resta
// solo lato sync: OPTCG -> onepiece-catalog-sync -> card_printings.
import { api } from '../../api.js';

const cache = new Map();

export async function searchCards(query) {
  const value = String(query || '').trim();
  if (value.length < 2) return [];
  const key = value.toLowerCase();
  if (cache.has(key)) return cache.get(key);
  let rows = [];
  try { rows = await api.onePieceCatalogSearch(value, 60) || []; } catch { rows = []; }
  const results = groupPrintingsIntoCards(rows).slice(0, 8);
  cache.set(key, results);
  return results;
}

export async function findCard(name) {
  const matches = await searchCards(name);
  const normalized = String(name || '').trim().toLowerCase();
  return matches.find(card => card.name.toLowerCase() === normalized) || null;
}

// Usato dall'import OPTCGSim (P1.1): risolve un catalogCardId ESATTO (es.
// "OP17-086"), non un nome — search_onepiece_catalog cerca anche su
// catalog_card_id, quindi basta riusare searchCards e filtrare sull'id
// esatto tra i risultati.
export async function findCardById(id) {
  const normalized = String(id || '').trim().toUpperCase();
  if (!normalized) return null;
  const matches = await searchCards(normalized);
  return matches.find(card => String(card.id).toUpperCase() === normalized) || null;
}

const costCache = new Map();

// Usato dal Deck Builder per l'ordinamento "Costo" (P1.x): il costo non è
// persistito su deck_cards (è metadata di catalogo, non inventario), quindi
// va risolto per catalogCardId ogni volta che serve — stesso ruolo di
// cardTypesByIds per Yu-Gi-Oh, ma risolto da card_printings invece che da
// YGOPRODeck. Le carte senza costo (es. Stage) tornano null, non 0: 0 è un
// costo reale (i pochi Leader/Character a costo 0), null vuol dire "questa
// carta non ha un costo".
export async function cardCostsByIds(ids) {
  const unique = [...new Set((ids || []).map(id => String(id || '').trim()).filter(Boolean))];
  const missing = unique.filter(id => !costCache.has(id));
  if (missing.length) {
    let rows = [];
    try { rows = await api.onePieceCardCosts(missing) || []; } catch { rows = []; }
    const resolved = new Set();
    for (const row of rows) {
      const id = String(row.catalog_card_id ?? row.catalogCardId ?? '').trim();
      if (!id) continue;
      const cost = row.cost === null || row.cost === undefined ? null : Number(row.cost);
      costCache.set(id, Number.isFinite(cost) ? cost : null);
      resolved.add(id);
    }
    for (const id of missing) if (!resolved.has(id)) costCache.set(id, null);
  }
  const map = {};
  for (const id of unique) map[id] = costCache.get(id) ?? null;
  return map;
}

function imageFilenameStem(imageUrl) {
  const filename = String(imageUrl || '').split('/').pop() || '';
  return filename.replace(/\.(jpe?g|png|webp|gif)$/i, '');
}

// Caso Hawkins: stessa regola di supabase/functions/onepiece-catalog-sync/
// normalizer.mjs:imageMatchesCode (duplicata qui, non importabile da un
// Edge Function — vedi commento in cima a quel file) — rete di sicurezza
// per righe già in DB da prima del fix di sync, o non ancora risincronizzate.
// Se il filename dell'immagine ha la forma di UN ALTRO codice carta, non la
// usiamo: si comporta come "immagine mancante" (fallback riga sotto).
// Fix 2026-09-11 (falso positivo confermato sull'audit reale): alcuni promo
// hanno il suffisso di variante già dentro il catalog_card_id stesso (es.
// "P-029_R1"), non solo nel filename — va spogliato da ENTRAMBI i lati
// prima di confrontare, altrimenti "P-029" (dal filename) vs "P-029_R1"
// (catalog_card_id intero) risulta un falso cross-code. Vedi stesso fix in
// supabase/functions/onepiece-catalog-sync/normalizer.mjs:baseCode.
const CODE_LIKE_IMAGE_PATTERN = /^(([A-Z]{1,4}\d{0,3}-\d{1,4})|(DON[_-]?\d+))(?:_.+)?$/i;
function baseCode(value) {
  const match = String(value || '').toUpperCase().match(CODE_LIKE_IMAGE_PATTERN);
  return match ? match[1].replace(/^DON-/, 'DON_') : null;
}
function imageMatchesCode(catalogCardId, imageUrl) {
  const stem = imageFilenameStem(imageUrl);
  if (!stem) return true;
  const imageBase = baseCode(stem);
  if (imageBase === null) return true;
  const catalogBase = baseCode(catalogCardId) ?? String(catalogCardId || '').toUpperCase();
  return imageBase === catalogBase;
}

// search_onepiece_catalog restituisce PRINTING fisiche, una riga per
// variante (regular/parallel/alt art/promo): il raggruppamento in "carte
// logiche" per catalog_card_id è deliberatamente lato client, non lato SQL
// (Fase 4A) — così la stessa ricerca su "Nami" può restituire
// OP01-016 (regular) e OP01-016_p1 (parallel) come printing distinte di
// un'unica carta, esattamente come il motore Yu-Gi-Oh! fa già con i suoi set.
function groupPrintingsIntoCards(rows) {
  const groups = new Map();
  for (const row of rows) {
    const catalogCardId = String(row.catalog_card_id || '').trim();
    if (!catalogCardId) continue;
    const metadata = row.game_metadata && typeof row.game_metadata === 'object' ? row.game_metadata : {};
    const rawImage = row.image_url || '';
    const printing = {
      printingId: row.printing_id || null,
      variantId: row.variant_id || '',
      setCode: row.set_code || '',
      setName: row.set_name || '',
      rarity: row.rarity || '',
      image: rawImage && imageMatchesCode(catalogCardId, rawImage) ? rawImage : ''
    };
    const existing = groups.get(catalogCardId);
    if (existing) {
      existing.printings.push(printing);
      // Immagine mancante su questa printing ma presente su un'altra variante
      // della stessa carta: fallback solo per la miniatura della carta
      // logica, mai scritto sulla printing stessa (Fase 4.10 — nessun repair
      // automatico dei dati, solo una UI che non mostra un buco).
      if (!existing.image && printing.image) { existing.image = printing.image; existing.fullImage = printing.image; }
      continue;
    }
    groups.set(catalogCardId, {
      id: catalogCardId,
      name: row.card_name || '',
      type: metadata.cardType || '',
      image: printing.image,
      fullImage: printing.image,
      // Stesso catalogCardId => stesso set_code sempre (P1.0.1, filtro
      // Espansione nel Deck Builder): un catalogCardId come "OP01-016" porta
      // già il codice set nel prefisso, quindi tutte le sue printing
      // condividono lo stesso set_code lato RPC.
      setCode: printing.setCode || '',
      colors: Array.isArray(metadata.colors) ? metadata.colors : [],
      cost: metadata.cost ?? null,
      power: metadata.power ?? null,
      counter: metadata.counter ?? null,
      subType: Array.isArray(metadata.traits) ? metadata.traits.join(' / ') : '',
      attribute: metadata.attribute || '',
      printings: [printing]
    });
  }
  return [...groups.values()];
}
