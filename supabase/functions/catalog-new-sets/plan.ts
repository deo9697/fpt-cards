// Piano di riempimento automatico del catalogo per un set Yu-Gi-Oh! nuovo
// (2026-10-24, dopo il caso BETB). Funzione pura, nessuna rete: la usa
// index.ts e la prova scripts/catalog-new-sets-plan-smoke.mjs.
//
// Fonti indipendenti, tutte devono concordare:
// - YGOPRODeck: codici inglesi, carta (id) e rarità;
// - YGOResources printcode: per ogni lingua, numero -> id carta Konami;
// - YGOResources indice nomi EN: nome inglese -> id carta Konami.
// Una stampa inglese entra solo se l'id Konami del suo numero corrisponde al
// nome YGOPRODeck; le altre lingue solo con lo stesso id Konami dell'inglese.
// Rarità: solo etichette che il guardiano del DB restituisce identiche
// (allowedRarities); "New"/"Reprint" restano fuori (al momento della scansione
// le copre il fallback Konami della Fast Scan).
export const LANGUAGES = ['EN', 'IT', 'FR', 'DE', 'SP', 'PT'];

type Card = { id: number | string, name: string, card_sets?: { set_code?: string, set_rarity?: string }[] };
type Extra = { card: Card, rarities: string[] };
export type Row = { game: 'yugioh', catalog_card_id: string, card_name: string, set_code: string, set_name: string, rarity: string, image_url: string, variant_id: '' };

const comparable = (value: unknown) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const decode = (value: unknown) => String(value ?? '').replace(/&#0*39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
export const identityKey = (row: { catalog_card_id: string, set_code: string, rarity: string, variant_id?: string }) => [row.catalog_card_id, row.set_code, row.rarity, row.variant_id || ''].join('|');

export function konamiIdsByName(nameIndex: Record<string, (number | string)[]>) {
  const map = new Map<string, Set<string>>();
  for (const [name, ids] of Object.entries(nameIndex || {})) {
    const key = comparable(name);
    const set = map.get(key) || new Set<string>();
    for (const id of ids || []) set.add(String(id));
    map.set(key, set);
  }
  return map;
}

// Numeri che YGOResources conosce in inglese ma YGOPRODeck non elenca nel set
// (stampe speciali, es. BETB-ENSP1): il chiamante li risolve a parte.
export function unlistedEnglishNumbers(set: string, ygoCards: Card[], printcodes: Record<string, Record<string, number | string>>) {
  const listed = new Set(ygoCards.flatMap(card => (card.card_sets || []).map(row => String(row.set_code || '').toUpperCase())));
  return Object.keys(printcodes.EN || {}).filter(number => !listed.has(`${set}-EN${number}`));
}

export function planNewSet({ set, setName, ygoCards = [], printcodes = {}, namesToKonami, existing = new Set<string>(), allowedRarities = new Set<string>(), extras = {}, canonicalId = (id: unknown) => String(id) }: {
  set: string, setName: string, ygoCards?: Card[], printcodes?: Record<string, Record<string, number | string>>,
  namesToKonami: Map<string, Set<string>>, existing?: Set<string>, allowedRarities?: Set<string>,
  extras?: Record<string, Extra>, canonicalId?: (id: unknown) => string
}) {
  const rows: Row[] = [], issues: { code: string, reason: string }[] = [];
  const known = new Set(existing);
  const english = printcodes.EN || {};
  const make = (card: Card, code: string, rarity: string): Row => ({ game: 'yugioh', catalog_card_id: canonicalId(card.id), card_name: decode(card.name), set_code: code, set_name: decode(setName), rarity, image_url: `https://images.ygoprodeck.com/images/cards/${card.id}.jpg`, variant_id: '' });
  const add = (row: Row) => { const key = identityKey(row); if (known.has(key)) return; known.add(key); rows.push(row); };
  if (!Object.keys(english).length) return { rows, issues: [{ code: `${set}-EN`, reason: 'YGOResources non ha ancora i codici inglesi del set' }] };

  // 1. Inglese.
  const byCode = new Map<string, { card: Card, rarities: Set<string>, conflict?: boolean }>();
  for (const card of ygoCards) for (const printing of card.card_sets || []) {
    const code = String(printing.set_code || '').trim().toUpperCase();
    if (!code.startsWith(`${set}-EN`)) continue;
    const entry = byCode.get(code) || { card, rarities: new Set<string>() };
    if (String(entry.card.id) !== String(card.id)) entry.conflict = true;
    entry.rarities.add(String(printing.set_rarity || '').trim());
    byCode.set(code, entry);
  }
  // Rarità inglesi già nel catalogo (già passate dal guardiano, es. le MAMO
  // GMR prese dalla scheda Konami dove YGOPRODeck dice "New"): valgono come
  // fonte per le traduzioni, per la stessa carta.
  const catalogRarities = new Map<string, Set<string>>();
  for (const key of existing) {
    const [catalogId, code, rarity, variant] = key.split('|');
    if (variant || !code?.startsWith(`${set}-EN`)) continue;
    const entry = catalogRarities.get(`${catalogId}|${code}`) || new Set<string>();
    entry.add(rarity); catalogRarities.set(`${catalogId}|${code}`, entry);
  }
  const verified = new Map<string, { card: Card, rarities: string[] }>();
  const accept = (number: string, code: string, card: Card, rarities: string[]) => {
    const konamiId = String(english[number] ?? '');
    if (!konamiId) { issues.push({ code, reason: 'numero assente da YGOResources' }); return; }
    if (!namesToKonami.get(comparable(card.name))?.has(konamiId)) { issues.push({ code, reason: `"${card.name}" non corrisponde all'id Konami ${konamiId}` }); return; }
    const known = catalogRarities.get(`${canonicalId(card.id)}|${code}`) || new Set<string>();
    const good = [...new Set([...rarities.filter(rarity => allowedRarities.has(rarity)), ...known])];
    for (const rarity of rarities.filter(rarity => !allowedRarities.has(rarity) && !known.size)) issues.push({ code, reason: `rarità "${rarity}" non riconosciuta: esclusa` });
    if (!good.length) return;
    verified.set(number, { card, rarities: good });
    for (const rarity of good) add(make(card, code, rarity));
  };
  for (const [code, entry] of byCode) {
    if (entry.conflict) { issues.push({ code, reason: 'più carte YGOPRODeck sullo stesso codice' }); continue; }
    accept(code.slice(set.length + 3), code, entry.card, [...entry.rarities]);
  }
  for (const [number, extra] of Object.entries(extras)) if (!verified.has(number)) accept(number, `${set}-EN${number}`, extra.card, extra.rarities);

  // 2. Altre lingue: stesso id Konami dell'inglese verificato.
  for (const language of LANGUAGES.slice(1)) {
    for (const [number, konamiId] of Object.entries(printcodes[language] || {})) {
      const code = `${set}-${language}${number}`, source = verified.get(number);
      if (!source) continue;
      if (String(konamiId) !== String(english[number])) { issues.push({ code, reason: `id Konami ${konamiId} diverso dall'inglese ${english[number]}` }); continue; }
      for (const rarity of source.rarities) add(make(source.card, code, rarity));
    }
  }
  return { rows, issues };
}

// Il set è completo quando ogni codice di YGOResources (tutte le lingue) ha
// almeno una stampa nel catalogo.
export function missingCodes(set: string, printcodes: Record<string, Record<string, number | string>>, existingCodes: Set<string>) {
  const missing: string[] = [];
  for (const language of LANGUAGES) for (const number of Object.keys(printcodes[language] || {})) {
    const code = `${set}-${language}${number}`;
    if (!existingCodes.has(code)) missing.push(code);
  }
  return missing;
}
