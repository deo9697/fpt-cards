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
    const printing = {
      printingId: row.printing_id || null,
      variantId: row.variant_id || '',
      setCode: row.set_code || '',
      setName: row.set_name || '',
      rarity: row.rarity || '',
      image: row.image_url || ''
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
