const ONE_PIECE_ENDPOINTS = [
  'https://optcgapi.com/api/sets/filtered/',
  'https://optcgapi.com/api/decks/filtered/',
  'https://optcgapi.com/api/promos/filtered/'
];
const cache = new Map();

export async function searchCards(query) {
  const value = String(query || '').trim();
  if (value.length < 3) return [];
  const key = value.toLowerCase();
  if (cache.has(key)) return cache.get(key);
  const batches = await Promise.all(ONE_PIECE_ENDPOINTS.map(async endpoint => {
    try {
      const response = await fetch(`${endpoint}?card_name=${encodeURIComponent(value)}`);
      return response.ok ? await response.json() : [];
    } catch { return []; }
  }));
  const variantCounts = new Map();
  const unique = new Map();
  batches.flat().forEach(card => {
    const rawId = String(card.card_set_id || card.card_image_id || '').trim();
    if (!rawId) return;
    const variantIndex = (variantCounts.get(rawId) || 0) + 1;
    variantCounts.set(rawId, variantIndex);
    const mapped = mapOnePieceCard(card, variantIndex);
    if (!unique.has(mapped.id)) unique.set(mapped.id, mapped);
  });
  const results = [...unique.values()].slice(0, 8);
  cache.set(key, results);
  return results;
}

export async function findCard(name) {
  const matches = await searchCards(name);
  const normalized = String(name || '').trim().toLowerCase();
  return matches.find(card => card.name.toLowerCase() === normalized) || null;
}

// Forma comune con l'adapter Yu-Gi-Oh!: id/name/type/image/printings.
// variantId esiste solo nel modello client finché l'audit su card_printings
// non decide come persisterlo (vedi memoria "Game Adapter" del 2026-09-08).
// colors/cost/power/counter/subType/attribute arrivano già così dall'API
// OPTCG live (card_color, card_cost, card_power, counter_amount, sub_types,
// attribute) — nessuna dipendenza da DB, quindi possono esistere nel modello
// client da subito e alimentare il filtro colore Leader del Deck Builder.
// Non sono ancora persistiti in Raccolta: quei filtri restano `ready:false`
// finché il catalog sync (Fase 2-4) non li scrive su card_printings.
function mapOnePieceCard(card, variantIndex = 1) {
  const id = String(card.card_set_id || card.card_image_id || '').trim();
  return {
    id,
    variantId: id ? `${id}_p${variantIndex}` : '',
    name: card.card_name || '',
    type: card.card_type || '',
    image: card.card_image || '',
    fullImage: card.card_image || '',
    colors: normalizeColors(card.card_color),
    cost: normalizeStat(card.card_cost),
    power: normalizeStat(card.card_power),
    counter: normalizeStat(card.counter_amount),
    subType: String(card.sub_types || '').trim(),
    attribute: String(card.attribute || '').trim(),
    printings: [{
      setCode: id,
      setName: card.card_set_name || card.set_name || '',
      rarity: card.card_rarity || card.rarity || ''
    }]
  };
}

function normalizeColors(value) { return String(value || '').split(/[\/,]/).map(color => color.trim()).filter(Boolean); }
function normalizeStat(value) { const number = Number(value); return Number.isFinite(number) ? number : null; }
