// Piano di riempimento del catalogo per UN set Yu-Gi-Oh! appena uscito
// (2026-10-24, caso reale Beyond the Brave / BETB: registro Konami completo
// in IT/PT, catalogo con 9 stampe su 303). Funzione pura: nessuna rete, nessun
// DB — l'involucro CLI è scripts/catalog-add-set.mjs.
//
// Regole (tutte devono valere, altrimenti la riga non entra e finisce nel report):
// - inglese: codice e rarità da YGOPRODeck, confermati dalla scheda ufficiale
//   Konami (stesso nome carta, stesse rarità);
// - altre lingue: solo codici presenti nel registro Konami (ygo_printcode_entries)
//   con lo STESSO id carta Konami della stampa inglese di quel numero;
// - numeri del registro che YGOPRODeck non elenca (es. BETB-ITSP1): ammessi se
//   la scheda Konami del codice inglese ha lo stesso id del registro e la carta
//   è nota a YGOPRODeck per nome esatto (catalogCardId reale, mai inventato).
export const FILL_LANGUAGES = ['IT', 'FR', 'DE', 'SP', 'PT'];

const comparable = value => String(value || '').toLocaleLowerCase('en').replace(/[^a-z0-9]/g, '');
const decode = value => String(value ?? '').replace(/&#0*39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const identity = row => [row.catalog_card_id, row.set_code, row.rarity, row.variant_id || ''].join('|');

export function planSetFill({ setCode, setName, ygoCards = [], registry = [], existing = [], konami = {}, extraCards = {}, canonicalId = id => String(id) }) {
  const set = String(setCode).toUpperCase();
  const known = new Set(existing.map(identity));
  const rows = [], issues = [];
  const add = row => { if (known.has(identity(row))) return; known.add(identity(row)); rows.push(row); };
  const make = (card, code, rarity) => ({ game: 'yugioh', catalog_card_id: canonicalId(card.id), card_name: card.name, set_code: code, set_name: decode(setName), rarity, image_url: `https://images.ygoprodeck.com/images/cards/${card.id}.jpg`, variant_id: '' });

  // 1. Inglese: YGOPRODeck, confermato da Konami.
  const english = new Map();
  for (const card of ygoCards) for (const printing of card.card_sets || []) {
    const code = String(printing.set_code || '').trim().toUpperCase();
    if (!code.startsWith(`${set}-EN`)) continue;
    const entry = english.get(code) || english.set(code, { card, rarities: new Set() }).get(code);
    if (String(entry.card.id) !== String(card.id)) { issues.push({ code, reason: 'più carte YGOPRODeck sullo stesso codice' }); entry.conflict = true; }
    entry.rarities.add(String(printing.set_rarity || '').trim());
  }
  const konamiIdByNumber = new Map(), cardByNumber = new Map();
  for (const [code, entry] of english) {
    const official = konami[code];
    if (entry.conflict) continue;
    if (!official?.konamiId) { issues.push({ code, reason: 'scheda Konami non trovata' }); continue; }
    if (comparable(official.cardName) !== comparable(entry.card.name)) { issues.push({ code, reason: `nome diverso: Konami "${official.cardName}", YGOPRODeck "${entry.card.name}"` }); continue; }
    const ygo = [...entry.rarities].sort().join(' | '), off = [...new Set(official.rarities || [])].sort().join(' | ');
    if (ygo !== off) { issues.push({ code, reason: `rarità diverse: YGOPRODeck ${ygo || '—'}, Konami ${off || '—'}` }); continue; }
    const number = code.slice(set.length + 3);
    konamiIdByNumber.set(number, String(official.konamiId));
    cardByNumber.set(number, { card: entry.card, rarities: [...entry.rarities] });
    for (const rarity of entry.rarities) add(make(entry.card, code, rarity));
  }

  // 2. Numeri del registro senza inglese su YGOPRODeck (stampe speciali).
  const registryNumbers = new Set(registry.filter(row => String(row.set_prefix).startsWith(`${set}-`)).map(row => row.print_number));
  for (const number of registryNumbers) {
    if (cardByNumber.has(number)) continue;
    const code = `${set}-EN${number}`, official = konami[code], card = extraCards[code];
    const registryIds = new Set(registry.filter(row => row.print_number === number).map(row => String(row.konami_card_id)));
    if (!official?.konamiId || !registryIds.has(String(official.konamiId))) { issues.push({ code, reason: 'numero del registro non confermato dalla scheda Konami' }); continue; }
    if (!card || comparable(card.name) !== comparable(official.cardName)) { issues.push({ code, reason: `carta "${official.cardName}" non trovata su YGOPRODeck per nome esatto` }); continue; }
    konamiIdByNumber.set(number, String(official.konamiId));
    cardByNumber.set(number, { card, rarities: official.rarities || [] });
    for (const rarity of official.rarities || []) add(make(card, code, rarity));
  }

  // 3. Altre lingue: registro Konami, stesso id carta del gemello inglese.
  for (const entry of registry) {
    const prefix = String(entry.set_prefix || '').toUpperCase(), language = prefix.slice(-2);
    if (!prefix.startsWith(`${set}-`) || !FILL_LANGUAGES.includes(language)) continue;
    const code = prefix + entry.print_number, source = cardByNumber.get(entry.print_number);
    if (!source) continue; // già nel report al passo 1/2
    if (konamiIdByNumber.get(entry.print_number) !== String(entry.konami_card_id)) { issues.push({ code, reason: `id Konami ${entry.konami_card_id} diverso dal gemello inglese ${konamiIdByNumber.get(entry.print_number)}` }); continue; }
    for (const rarity of source.rarities) add(make(source.card, code, rarity));
  }
  return { rows, issues, englishCodes: english.size, registryCodes: registry.length };
}

export function setFillSql(rows) {
  if (!rows.length) return '-- nessuna riga nuova\n';
  const esc = value => `'${String(value ?? '').replace(/'/g, "''")}'`;
  const values = rows.map(row => `(${['game', 'catalog_card_id', 'card_name', 'set_code', 'set_name', 'rarity', 'image_url', 'variant_id'].map(key => esc(row[key])).join(',')})`);
  return `insert into public.card_printings(game, catalog_card_id, card_name, set_code, set_name, rarity, image_url, variant_id)\nvalues\n${values.join(',\n')}\non conflict on constraint card_printings_identity_key do nothing;\n`;
}
