const ENDPOINT = 'https://db.ygoprodeck.com/api/v7/cardinfo.php';
const SET_ENDPOINT = 'https://db.ygoprodeck.com/api/v7/cardsetsinfo.php';
const cache = new Map();
const identityCache = new Map();
const printingCache = new Map();
const TCG_BANLIST_CACHE_KEY = 'fpt-cards-tcg-banlist-v1';
const TCG_BANLIST_MAX_AGE = 6 * 60 * 60 * 1000;
let tcgBanlistRequest;

// Alias catalogo confermati e persistiti anche in card_catalog_aliases.
// Il nome carta non deve mai trasformare due ID validi differenti nella stessa identita.
const YUGIOH_CATALOG_ALIASES = new Map([
  ['94145022','94145021'],
  ['73642296','73642297'],
  ['89631140','89631139'], ['89631141','89631139'], ['89631142','89631139'],
  ['89631143','89631139'], ['89631144','89631139'], ['89631145','89631139'],
  ['89631146','89631139']
]);

export function validCatalogCardId(value, game = 'yugioh') {
  const id = String(value || '').trim();
  if (!id || ['0','null','undefined','unknown'].includes(id.toLowerCase())) return false;
  return game === 'yugioh' ? /^\d{5,10}$/.test(id) : id.length <= 100;
}

export function canonicalCatalogCardId(value, game = 'yugioh') {
  const id = String(value || '').trim();
  if (!validCatalogCardId(id, game)) return '';
  return game === 'yugioh' ? (YUGIOH_CATALOG_ALIASES.get(id) || id) : id;
}

export function catalogImageNeedsRepair(catalogCardId, imageUrl, game = 'yugioh') {
  if (!validCatalogCardId(catalogCardId, game) || !String(imageUrl || '').trim()) return true;
  if (game !== 'yugioh') return false;
  const imageId = String(imageUrl).match(/\/([0-9]{5,10})\.(?:jpe?g|png|webp)(?:[?#].*)?$/i)?.[1];
  return Boolean(imageId && canonicalCatalogCardId(imageId, game) !== canonicalCatalogCardId(catalogCardId, game));
}

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
  const [italianExact, englishExact] = await Promise.all([
    requestCards({ name:value, language:'it' }),
    requestCards({ name:value })
  ]);
  const wanted = normalizeName(value);
  const exact = [...italianExact, ...englishExact].find(card => normalizeName(card.name) === wanted);
  if (exact) return mapCard(exact);
  const matches = await searchCards(value);
  return matches.find(card => normalizeName(card.name) === wanted)
    || matches.find(card => isConfidentAlias(card.name, value))
    || null;
}

export async function findCardById(id, expectedName = '', game = 'yugioh') {
  if (game !== 'yugioh') return null;
  const candidates = await cardsById(id);
  if (!candidates.length) return null;
  const expected = normalizeName(expectedName);
  const match = expected ? candidates.find(card => normalizeName(card.name) === expected) : candidates[0];
  return match || null;
}

export async function resolveStoredCard({ id = '', name = '', setCode = '' } = {}, game = 'yugioh') {
  if (game !== 'yugioh' || !name) return null;
  const byId = id ? await findCardById(id, name, game) : null;
  if (byId) return byId;
  const matches = await searchCards(name, game);
  const wantedSet = String(setCode || '').trim().toUpperCase();
  if (wantedSet) {
    const bySet = matches.find(card => card.printings?.some(printing =>
      String(printing.setCode || '').trim().toUpperCase() === wantedSet
    ));
    if (bySet) return bySet;
  }
  const wantedName = normalizeName(name);
  return matches.find(card => normalizeName(card.name) === wantedName)
    || matches.find(card => isConfidentAlias(card.name, name))
    || null;
}

export async function verifyCardIdentity(id, expectedName, game = 'yugioh') {
  if (game !== 'yugioh' || !id || !expectedName) return null;
  const candidates = await cardsById(id);
  if (!candidates.length) return null;
  const expected = normalizeName(expectedName);
  return candidates.some(card => normalizeName(card.name) === expected);
}

export async function reconcileCatalogCard({ game = 'yugioh', catalogCardId = '', cardName = '', setCode = '', rarity = '', imageUrl = '' } = {}) {
  if (game !== 'yugioh') return { status:'warning', card:null, issues:['Catalogo remoto non verificabile per questo gioco'] };
  if (!catalogCardId || !cardName) return { status:'mismatch', card:null, issues:['ID catalogo o nome mancante'] };
  const card = await findCardById(catalogCardId, cardName, game);
  if (!card) return { status:'mismatch', card:null, issues:['Nome e catalog ID non identificano la stessa carta'] };
  const issues = [];
  const wantedSet = String(setCode || '').trim().toUpperCase();
  const printing = wantedSet ? card.printings.find(item => String(item.setCode || '').trim().toUpperCase() === wantedSet) : null;
  if (wantedSet && !printing) issues.push('Set code non presente nel catalogo della carta');
  if (printing && rarity && printing.rarity && printing.rarity !== rarity) issues.push('Rarità diversa dal catalogo per questa printing');
  if (imageUrl && cardImageMatches(card, imageUrl) === false) issues.push('Immagine riferita a un altro catalog ID');
  return { status:issues.some(issue => issue.startsWith('Immagine')) ? 'mismatch' : issues.length ? 'warning' : 'valid', card, issues };
}

export async function lookupPrintingBySetCode(setCode, game = 'yugioh') {
  if (game !== 'yugioh') return [];
  const code=String(setCode||'').trim().toUpperCase(); if(!code)return[];
  if(printingCache.has(code))return printingCache.get(code);
  try {
    const mapped=[];
    for(const catalogCode of catalogSetCodeCandidates(code)){
      const response=await fetch(`${SET_ENDPOINT}?setcode=${encodeURIComponent(catalogCode)}`);
      if(!response.ok)continue;
      const payload=await response.json(); const rows=Array.isArray(payload)?payload:payload?.data?payload.data:payload?.id?[payload]:[];
      const exact=rows.filter(row=>String(row.set_code||'').trim().toUpperCase()===catalogCode);
      for(const row of exact.slice(0,8)){
        const card=await findCardById(row.id,row.name,'yugioh');
        if(!card)continue;
        const reconciliation=await reconcileCatalogCard({game:'yugioh',catalogCardId:row.id,cardName:row.name,setCode:row.set_code,rarity:row.set_rarity,imageUrl:card.fullImage||card.image});
        if(reconciliation.status==='mismatch')continue;
        const localized=catalogCode!==code;
        mapped.push({printingId:'',game:'yugioh',catalogCardId:String(row.id),cardName:row.name,setCode:code,setName:row.set_name||'',rarity:row.set_rarity||'',imageUrl:card.fullImage||card.image||'',warning:localized?`Codice locale verificato tramite ${catalogCode}`:reconciliation.status==='warning'?reconciliation.issues.join('. '):''});
      }
      if(mapped.length)break;
    }
    const unique=[...new Map(mapped.map(item=>[[item.catalogCardId,item.setCode,item.rarity].join(':'),item])).values()];printingCache.set(code,unique);return unique;
  } catch { return []; }
}

function catalogSetCodeCandidates(code) {
  const output=[code]; const localized=code.match(/^(.+)-(IT|FR|DE|SP|PT)(\d{1,4}[A-Z]?)$/);
  if(localized)output.push(`${localized[1]}-EN${localized[3]}`);
  return output;
}

export function cardImageMatches(card, url) {
  const imageId = String(url || '').match(/\/([0-9]{5,10})\.(?:jpe?g|png)(?:[?#].*)?$/i)?.[1];
  if (!imageId || !Array.isArray(card?.imageIds) || !card.imageIds.length) return null;
  return card.imageIds.includes(imageId);
}

async function cardsById(id) {
  const value = String(id || '').trim();
  if (!/^\d{5,10}$/.test(value)) return [];
  if (identityCache.has(value)) return identityCache.get(value);
  const request = Promise.all([
    requestCards({ id:value, language:'it' }),
    requestCards({ id:value })
  ]).then(([italianCards, englishCards]) => {
    const unique = new Map();
    [...italianCards, ...englishCards]
      .filter(card => String(card.id) === value)
      .map(mapCard)
      .forEach(card => unique.set(normalizeName(card.name), card));
    return [...unique.values()];
  });
  identityCache.set(value, request);
  const candidates = await request;
  if (candidates.length) identityCache.set(value, candidates);
  else identityCache.delete(value);
  return candidates;
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
  return matches.find(card => card.name.toLowerCase() === normalized) || null;
}

function mapOnePieceCard(card) {
  const setCode = card.card_set_id || card.card_image_id || '';
  return {
    id: card.card_image_id || card.card_set_id || '',
    name: card.card_name || '',
    type: [card.card_set_id, card.card_type].filter(Boolean).join(' · '),
    image: card.card_image || '',
    fullImage: card.card_image || '',
    printings: [{
      setCode,
      setName: card.card_set_name || card.set_name || '',
      rarity: card.card_rarity || card.rarity || ''
    }]
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
  const artworks = Array.isArray(card.card_images) ? card.card_images : [];
  const artwork = artworks.find(image => String(image?.id || '') === String(card.id || ''))
    || artworks[0]
    || {};
  return {
    id: card.id,
    name: card.name,
    type: card.type,
    // image_url_cropped contiene soltanto l'illustrazione interna: non va usato
    // come immagine della carta nelle liste o nei dati persistenti.
    image: artwork.image_url_small || artwork.image_url || artwork.image_url_cropped || '',
    fullImage: artwork.image_url || artwork.image_url_small || artwork.image_url_cropped || '',
    banTcg: normalizeTcgBanStatus(card.banlist_info?.ban_tcg),
    imageIds: artworks.map(image => String(image.id || '')).filter(Boolean),
    printings: (card.card_sets || []).map(printing => ({
      setCode: printing.set_code || '',
      setName: printing.set_name || '',
      rarity: printing.set_rarity || ''
    }))
  };
}

export function normalizeTcgBanStatus(value) {
  const status = String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (status === 'banned' || status === 'forbidden') return 'forbidden';
  if (status === 'limited') return 'limited';
  if (status === 'semilimited') return 'semi-limited';
  return '';
}

export async function tcgBanlistStatuses() {
  const cached = readTcgBanlistCache();
  if (cached) return cached;
  if (tcgBanlistRequest) return tcgBanlistRequest;
  tcgBanlistRequest = (async () => {
    try {
      const response = await fetch(`${ENDPOINT}?banlist=tcg`);
      if (!response.ok) return null;
      const rows = (await response.json()).data || [];
      const statuses = {};
      for (const card of rows) {
        const status = normalizeTcgBanStatus(card.banlist_info?.ban_tcg);
        if (status) statuses[String(card.id)] = status;
      }
      writeTcgBanlistCache(statuses);
      return statuses;
    } catch { return null; }
    finally { tcgBanlistRequest = null; }
  })();
  return tcgBanlistRequest;
}

function readTcgBanlistCache() {
  if (typeof localStorage === 'undefined') return null;
  try {
    const cached = JSON.parse(localStorage.getItem(TCG_BANLIST_CACHE_KEY) || 'null');
    return cached && Date.now() - Number(cached.updatedAt || 0) < TCG_BANLIST_MAX_AGE && cached.statuses && typeof cached.statuses === 'object' ? cached.statuses : null;
  } catch { return null; }
}

function writeTcgBanlistCache(statuses) {
  if (typeof localStorage === 'undefined') return;
  try { localStorage.setItem(TCG_BANLIST_CACHE_KEY, JSON.stringify({ updatedAt:Date.now(), statuses })); } catch {}
}

export function normalizeCardImageUrl(url) {
  const value = String(url || '');
  if (!/^https:\/\/images\.ygoprodeck\.com\/images\/cards_cropped\//i.test(value)) return value;
  return value.replace(/\/images\/cards_cropped\//i, '/images/cards/');
}

export function canonicalYgoCardImage(id) {
  const value = String(id || '').trim();
  return /^\d{5,10}$/.test(value) ? `https://images.ygoprodeck.com/images/cards/${value}.jpg` : '';
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

function isConfidentAlias(candidate, query) {
  const full = normalizeName(candidate);
  const partial = normalizeName(query);
  const tokens = partial.split(' ').filter(Boolean);
  if (tokens.length < 2 || partial.length < 7) return false;
  return full.startsWith(`${partial} `) || full.endsWith(` ${partial}`);
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
