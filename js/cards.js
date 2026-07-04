const ENDPOINT = 'https://db.ygoprodeck.com/api/v7/cardinfo.php';

export async function searchCards(query) {
  const value = query.trim();
  if (value.length < 3) return [];
  const response = await fetch(`${ENDPOINT}?fname=${encodeURIComponent(value)}`);
  if (!response.ok) return [];
  const payload = await response.json();
  return (payload.data || []).slice(0, 6).map(card => ({
    id: card.id,
    name: card.name,
    type: card.type,
    image: card.card_images?.[0]?.image_url_cropped || ''
  }));
}

export async function findCard(name) {
  const value = name.trim();
  if (!value) return null;
  try {
    const response = await fetch(`${ENDPOINT}?name=${encodeURIComponent(value)}`);
    if (response.ok) {
      const card = (await response.json()).data?.[0];
      if (card) return mapCard(card);
    }
  } catch {}
  const matches = await searchCards(value);
  return matches.find(card => card.name.toLowerCase() === value.toLowerCase()) || matches[0] || null;
}

function mapCard(card) {
  return {
    id: card.id,
    name: card.name,
    type: card.type,
    image: card.card_images?.[0]?.image_url_cropped || ''
  };
}
