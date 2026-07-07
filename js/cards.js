const ENDPOINT = 'https://db.ygoprodeck.com/api/v7/cardinfo.php';
const cache = new Map();

export async function searchCards(query) {
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

export async function findCard(name) {
  const value = name.trim();
  if (!value) return null;
  let exact = await requestCards({ name:value, language:'it' });
  if (!exact.length) exact = await requestCards({ name:value });
  if (exact[0]) return mapCard(exact[0]);
  const matches = await searchCards(value);
  return matches.find(card => card.name.toLowerCase() === value.toLowerCase()) || matches[0] || null;
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
