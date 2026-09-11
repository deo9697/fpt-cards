// Normalizzazione pura OPTCG -> riga card_printings. Nessuna API Deno/Node
// qui dentro (niente fetch, niente Deno.*): file condiviso letteralmente tra
// index.ts (Edge Function, runtime Deno) e scripts/onepiece-catalog-
// normalizer-smoke.mjs (test, runtime Node) — un solo posto dove vive questa
// logica, a differenza di market-sync/index.ts che deve duplicare
// market/providers.js perché lì l'import è un '../' che esce dalla function
// (vedi supabase/functions/market-sync/index.ts). Qui './normalizer.mjs' è
// un sibling nella stessa cartella della function: nessun problema di root
// virtuale del bundler.
//
// Identità pensata così (confermata su dati OPTCG reali, non assunta):
//   - carte normali/starter/promo: catalog_card_id = card_set_id (es. "OP01-016",
//     "P-024"), variant_id = card_image_id verbatim — per la stampa base
//     card_image_id combacia con card_set_id (quindi variant_id = catalog_card_id,
//     non stringa vuota), per le alt art ha un suffisso ("_p1", "_pr1", "_pr2"...).
//   - DON!!: niente card_set_id/set_id nel payload OPTCG. catalog_card_id =
//     variant_id = card_image_id (es. "don_183"), set_code fisso 'DON'.
//   - set_code per tutto il resto è il prefisso di catalog_card_id prima del
//     primo trattino ("OP01-016"->"OP01", "ST04-016"->"ST04", "P-024"->"P"):
//     per i promo questo produce già da solo un unico set_code condiviso
//     ("P"), senza bisogno di un caso speciale — l'API stessa conferma
//     set_id="P"/set_name="One Piece Promotion Cards" per l'intera categoria.

export const SOURCE_PROVIDER = 'optcgapi';

export function truncate(value, max) {
  const text = String(value ?? '');
  return text.length > max ? text.slice(0, max) : text;
}

export function deriveSetCode(catalogCardId) {
  const prefix = String(catalogCardId || '').split('-')[0].trim().toUpperCase();
  return prefix || 'UNKNOWN';
}

// "Red" -> ["Red"], "Red/Green" -> ["Red","Green"], "Red, Green" -> ["Red","Green"].
export function normalizeColorList(value) {
  return String(value || '').split(/[/,]/).map(part => part.trim()).filter(Boolean);
}

export function normalizeTraits(value) {
  return String(value || '').split(/[/,]/).map(part => part.trim()).filter(Boolean);
}

// Tollerante per design: un costo/potere mancante o scritto in modo strano
// (es. "-", "N/A") non deve mai far scartare l'intera carta — solo il
// singolo campo numerico resta null. Vedi Fase 3.5: "non if(!cost) reject".
export function cleanNumber(value) {
  const digits = String(value ?? '').replace(/[^\d-]/g, '');
  if (!digits || digits === '-') return null;
  const parsed = Number(digits);
  return Number.isFinite(parsed) ? parsed : null;
}

// Gli effetti Trigger OPTCG marcano il testo con un letterale "[Trigger]"
// nel card_text — non esiste un campo booleano/testuale dedicato nell'API.
export function extractTrigger(cardText) {
  const match = String(cardText || '').match(/\[Trigger\]\s*([^[]*)/i);
  return match ? match[1].trim() : '';
}

export function buildGameMetadata(raw) {
  return {
    colors: normalizeColorList(raw?.card_color),
    cardType: String(raw?.card_type || '').trim(),
    cost: cleanNumber(raw?.card_cost),
    power: cleanNumber(raw?.card_power),
    counter: cleanNumber(raw?.counter_amount),
    life: cleanNumber(raw?.life),
    attribute: String(raw?.attribute || '').trim(),
    traits: normalizeTraits(raw?.sub_types),
    effect: String(raw?.card_text || '').trim(),
    trigger: extractTrigger(raw?.card_text)
  };
}

function imageFilenameStem(imageUrl) {
  const filename = String(imageUrl || '').split('/').pop() || '';
  return filename.replace(/\.(jpe?g|png|webp|gif)$/i, '');
}

// Caso Hawkins (bug reale segnalato dall'utente 2026-09-10): OPTCG può
// restituire una printing (es. "OP10-109") con card_image che in realtà
// punta all'immagine di UN'ALTRA carta (es. "OP10-103") — due catalog_card_id
// già distinti, quindi resolveVariantCollisions() qui sotto non li vede mai
// (quello risolve solo collisioni sulla STESSA identity key). Forme di
// codice confermate dal vivo: "OP01-016"/"ST04-016" (set-numero), "P-017"
// (promo, un solo prefisso prima del trattino), "don_183" (DON!!, separatore
// non riconfermato dal vivo — solo il fixture sintetico del test usa "don-",
// per questo il pattern accetta sia "_" che "-" qui). Se il filename non ha
// affatto la forma di un codice (slug del nome carta, hash del CDN) non
// possiamo dire nulla da questa sola regola: non blocchiamo un'immagine solo
// perché il nome del file è "strano", solo quando sembra il codice di
// un'ALTRA carta.
const CODE_LIKE_IMAGE_PATTERN = /^([A-Z]{1,4}\d{0,3}-\d{1,4}|DON[_-]?\d+)(?:_.+)?$/i;

export function imageMatchesCode(catalogCardId, imageUrl) {
  const stem = imageFilenameStem(imageUrl);
  if (!stem) return true;
  const match = stem.match(CODE_LIKE_IMAGE_PATTERN);
  if (!match) return true;
  const normalize = value => String(value || '').toUpperCase().replace(/^DON-/, 'DON_');
  return normalize(match[1]) === normalize(catalogCardId);
}

// Copre allSetCards/allSTCards/allPromos (allPromoCards di fallback): stesso
// shape di record confermato dal vivo su tutti e tre gli endpoint.
export function normalizeStandardCard(raw, sourceUpdatedAt) {
  const catalogCardId = String(raw?.card_set_id || '').trim().toUpperCase();
  const cardName = String(raw?.card_name || '').trim();
  if (!catalogCardId || !cardName) return null;
  const variantId = String(raw?.card_image_id || catalogCardId).trim();
  const setCode = deriveSetCode(catalogCardId);
  const setName = String(raw?.set_name || '').trim() || (setCode === 'P' ? 'One Piece Promotion Cards' : '');
  const rawImageUrl = truncate(String(raw?.card_image || '').trim(), 500);
  const imageSuspect = rawImageUrl && !imageMatchesCode(catalogCardId, rawImageUrl);
  const metadata = buildGameMetadata(raw);
  if (imageSuspect) metadata.rawSuspectImageUrl = rawImageUrl;
  return {
    game: 'onepiece',
    catalog_card_id: truncate(catalogCardId, 100),
    variant_id: truncate(variantId, 100),
    card_name: truncate(cardName, 200),
    set_code: truncate(setCode, 100),
    set_name: truncate(setName, 200),
    rarity: truncate(String(raw?.rarity || '').trim(), 100),
    image_url: imageSuspect ? '' : rawImageUrl,
    game_metadata: metadata,
    source_provider: SOURCE_PROVIDER,
    source_updated_at: sourceUpdatedAt
  };
}

// allDonCards non ha card_set_id/set_id: solo card_image_id (es. "don_183").
export function normalizeDonCard(raw, sourceUpdatedAt) {
  const id = String(raw?.card_image_id || '').trim().toLowerCase();
  const cardName = String(raw?.card_name || '').trim();
  if (!id || !cardName) return null;
  const rawImageUrl = truncate(String(raw?.card_image || '').trim(), 500);
  const imageSuspect = rawImageUrl && !imageMatchesCode(id, rawImageUrl);
  const metadata = buildGameMetadata(raw);
  if (imageSuspect) metadata.rawSuspectImageUrl = rawImageUrl;
  return {
    game: 'onepiece',
    catalog_card_id: truncate(id, 100),
    variant_id: truncate(id, 100),
    card_name: truncate(cardName, 200),
    set_code: 'DON',
    set_name: 'DON!! Cards',
    rarity: truncate(String(raw?.rarity || 'DON!!').trim(), 100),
    image_url: imageSuspect ? '' : rawImageUrl,
    game_metadata: metadata,
    source_provider: SOURCE_PROVIDER,
    source_updated_at: sourceUpdatedAt
  };
}

// Deve combaciare esattamente con le colonne di card_printings_identity_key
// (supabase/migrations/20260908190500_..._foundation.sql) — se una cambia,
// deve cambiare anche l'altra, o il dedupe locale smette di rispecchiare
// cosa Postgres considera davvero la stessa riga.
export function identityKey(row) {
  return [row.game, row.catalog_card_id, row.set_code, row.rarity, row.variant_id].join('|');
}

function slugify(value, max = 60) {
  const slug = String(value || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  return truncate(slug, max);
}

// Bug reale confermato sui dati OPTCG dal vivo: molte ristampe promozionali/
// da torneo (Winner, Judge Pack, Treasure Cup, Celebration Pack, Demo Deck,
// Dash Pack...) riusano LO STESSO card_image_id della stampa base pur
// essendo carte a tutti gli effetti diverse (nome e immagine diversi) — a
// volte con card_image perfino vuoto lato OPTCG. La nostra identity key
// (catalog_card_id + set_code + rarity + variant_id) le confondeva con la
// stampa base: l'upsert ne "perdeva" una a caso, con effetti visibili come
// il codice di una carta che mostra l'immagine di un'altra, o l'etichetta
// "Alternate Art" presente/assente in modo incoerente da un sync all'altro.
//
// Gira DOPO la normalizzazione pura, PRIMA del dedupe/upsert, e tocca SOLO
// le righe effettivamente in collisione (stessa identity key, card_name
// diverso) — le altre migliaia di righe restano bit-per-bit identiche,
// altrimenti ogni riga già pulita si duplicherebbe nel DB al prossimo sync
// (mai una delete, vedi index.ts). Il suffisso usato per disambiguare è
// derivato dalla riga stessa (nome del file immagine se distintivo, altrimenti
// slug del card_name) — mai dall'ordine di elaborazione — così resta stabile
// da un sync all'altro invece di generare righe fantasma sempre nuove.
export function resolveVariantCollisions(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = [row.game, row.catalog_card_id, row.set_code, row.rarity, row.variant_id].join('|');
    const list = groups.get(key);
    if (list) list.push(row); else groups.set(key, [row]);
  }
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    if (new Set(list.map(row => row.card_name)).size < 2) continue; // duplicati veri, non una collisione
    for (const row of list) {
      const stem = imageFilenameStem(row.image_url);
      const upperStem = stem.toUpperCase(), upperCode = String(row.catalog_card_id).toUpperCase();
      // Filename "pulito" (combacia col codice carta, eventualmente con un
      // breve suffisso hash del CDN OPTCG): già univoco così com'è, non è
      // lui la fonte della collisione — usa lo slug del nome invece.
      const isCodeLikeFilename = upperStem === upperCode || upperStem.startsWith(`${upperCode}_`);
      const suffix = stem && !isCodeLikeFilename ? slugify(stem) : slugify(row.card_name);
      if (suffix) row.variant_id = truncate(`${row.variant_id}--${suffix}`, 100);
    }
  }
  return rows;
}
