// Lettura della scheda ufficiale Konami di una carta (database Konami, nessun
// CORS: si legge solo lato server). Condiviso da konami-card-rarities e
// catalog-new-sets. Solo parsing, nessuna dipendenza Deno.
export const KONAMI_CARD_SEARCH = 'https://www.db.yugioh-card.com/yugiohdb/card_search.action';

export function decodeEntities(value: string) {
  return value.replace(/&#0*39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

// Nome inglese della carta e rarità per un codice esatto (es. BETB-EN052).
export function parseKonamiCardPage(html: string, code: string) {
  const cardName = decodeEntities(html.match(/id="cardname"[^>]*>\s*<h1>\s*([^<]+?)\s*</)?.[1] || '');
  const rarities = new Set<string>();
  for (const block of html.split('<div class="inside">').slice(1)) {
    const number = block.match(/class="card_number">\s*([A-Z0-9-]+)\s*</)?.[1];
    const rarity = block.match(/<p>[^<]{1,6}<\/p>\s*<span[^>]*>\s*([^<]+?)\s*<\/span>/)?.[1];
    if (number === code && rarity) rarities.add(decodeEntities(rarity));
  }
  return { cardName, rarities: [...rarities] };
}

export async function fetchKonamiCardPage(konamiId: string, code: string) {
  const response = await fetch(`${KONAMI_CARD_SEARCH}?ope=2&cid=${encodeURIComponent(konamiId)}&request_locale=en`, {
    headers: { 'user-agent': 'Mozilla/5.0 (F.P.T Cards catalog check)' }, signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`konami_${response.status}`); }
  return parseKonamiCardPage(await response.text(), code);
}
