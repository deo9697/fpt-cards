const ENDPOINT = 'https://db.ygoprodeck.com/api/v7/cardinfo.php';
const cache = new Map();

export async function searchCards(query, game = 'yugioh') {
  if (game === 'onepiece') return searchOnePieceCards(query);
  const value = query.trim();
  if (value.length < 3) return [];
  const key = `yugioh:${normalizeName(value)}`;
  if (cache.has(key)) return cache.get(key);

  const [italianCards, englishCards] = await Promise.all([
    requestCards({ fname:value, language:'it' }),
    requestCards({ fname:value })
  ]);
  let cards = [...italianCards, ...englishCards];

  // L'API richiede spesso la punteggiatura ufficiale (es. dell'Incubo).
  // Se la frase non produce risultati, cerchiamo la parola più distintiva e
  // filtriamo/ordiniamo localmente ignorando apostrofi, accenti e trattini.
  if (!cards.length) {
    const fallback = fallbackToken(value);
    if (fallback && normalizeName(fallback) !== normalizeName(value)) {
      const [italianFallback, englishFallback] = await Promise.all([
        requestCards({ fname:fallback, language:'it' }),
        requestCards({ fname:fallback })
      ]);
      cards = [...italianFallback, ...englishFallback];
    }
  }

  const ranked = cards
    .map(mapCard)
    .map(card => ({ card, score:matchScore(card.name, value) }))
    .sort((a, b) => b.score - a.score || a.card.name.localeCompare(b.card.name, 'it'));
  const unique = new Map();
  ranked.forEach(({ card }) => { if (!unique.has(String(card.id))) unique.set(String(card.id), card); });
  const results = [...unique.values()].slice(0, 12);
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
  return matches.find(card => normalizeName(card.name) === normalizeName(value)) || matches[0] || null;
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

function normalizeName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['’`´-]/g, ' ')
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim()
    .toLocaleLowerCase('it');
}

function fallbackToken(value) {
  const ignored = new Set(['del', 'della', 'delle', 'degli', 'dello', 'dell', 'dei', 'di', 'da', 'con', 'per', 'the', 'of', 'and']);
  const candidates = normalizeName(value).split(' ').filter(token => token.length >= 3 && !ignored.has(token));
  return candidates[candidates.length - 1] || '';
}

function matchScore(name, query) {
  const candidate = normalizeName(name);
  const wanted = normalizeName(query);
  if (!candidate || !wanted) return 0;
  if (candidate === wanted) return 10000;
  let score = 0;
  if (candidate.startsWith(wanted)) score += 5000;
  if (candidate.includes(wanted)) score += 3000;
  const tokens = wanted.split(' ').filter(Boolean);
  const matched = tokens.filter(token => candidate.includes(token)).length;
  score += matched * 500;
  if (matched === tokens.length) score += 1500;
  score -= Math.abs(candidate.length - wanted.length);
  return score;
}
