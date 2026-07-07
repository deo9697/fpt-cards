const ENDPOINT = 'https://db.ygoprodeck.com/api/v7/cardinfo.php';
const cache = new Map();

export async function searchCards(query, game = 'yugioh') {
  if (game === 'onepiece') return searchOnePieceCards(query);
  const value = query.trim();
  if (value.length < 3) return [];
  const key = value.toLocaleLowerCase('it');
  if (cache.has(key)) return cache.get(key);

  let cards = await requestCards({ fname:value, language:'it' });
  if (!cards.length) cards = await requestCards({ fname:value });
  const results = cards.slice(0, 6).map(mapCard);
  cache.set(key, results);
  return results;
}

export async function findCard(name, game = 'yugioh') {
  if (game === 'onepiece') return findOnePieceCard(name);
  const value = name.trim();
  if (!value) return null;
  let exact = await requestCards({ name:value, language:'it' });
  if (!exact.length) exact = await requestCards({ name:value });
  if (exact[0]) return mapCard(exact[0]);
  const matches = await searchCards(value);
  return matches.find(card => card.name.toLowerCase() === value.toLowerCase()) || matches[0] || null;
}

const ONE_PIECE_ENDPOINTS = [
  'https://optcgapi.com/api/sets/filtered/',
  'https://optcgapi.com/api/decks/filtered/',
  'https://optcgapi.com/api/promos/filtered/'
];

async function searchOnePieceCards(query) {
  const value = query.trim();
  if (value.length < 3) return [];
  const key = `onepiece:${value.toLowerCase()}`;
  if (cache.has(key)) return cache.get(key);
  const batches = await Promise.all(ONE_PIECE_ENDPOINTS.map(async endpoint => {
    try {
      const response = await fetch(`${endpoint}?card_name=${encodeURIComponent(value)}`);
      return response.ok ? await response.json() : [];
    } catch { return []; }
  }));
  const unique = new Map();
  batches.flat().forEach(card => {
    const mapped = mapOnePieceCard(card);
    if (mapped.id && !unique.has(mapped.id)) unique.set(mapped.id, mapped);
  });
  const results = [...unique.values()].slice(0, 8);
  cache.set(key, results);
  return results;
}

async function findOnePieceCard(name) {
  const matches = await searchOnePieceCards(name);
  const normalized = name.trim().toLowerCase();
  return matches.find(card => card.name.toLowerCase() === normalized) || matches[0] || null;
}

function mapOnePieceCard(card) {
  return {
    id: card.card_set_id || card.card_image_id || '',
    name: card.card_name || '',
    type: [card.card_set_id, card.card_type].filter(Boolean).join(' · '),
    image: card.card_image || ''
  };
}

async function requestCards(parameters) {
  try {
    const query = new URLSearchParams(parameters);
    const response = await fetch(`${ENDPOINT}?${query}`);
    if (!response.ok) return [];
    return (await response.json()).data || [];
  } catch { return []; }
}

function mapCard(card) {
  return {
    id: card.id,
    name: card.name,
    type: card.type,
    image: card.card_images?.[0]?.image_url_cropped || ''
  };
}
