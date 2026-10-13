// Audit + riempimento del catalogo Yu-Gi-Oh! (card_printings), 2026-10-13.
// Usato per portare il catalogo dall'8-10% al ~98-99% dei codici del registro
// Konami (ygo_printcode_entries). Nessuna scrittura: genera report.json e
// insert-NN.sql idempotenti (on conflict do nothing) da provare e applicare.
//
// Uso:
//   1. dir/existing.json  = select game,catalog_card_id,card_name,set_code,set_name,rarity,
//                           coalesce(variant_id,'') variant_id from card_printings where game='yugioh'
//      dir/registry.json  = select set_prefix,print_number,konami_card_id from ygo_printcode_entries
//   2. curl "https://db.ygoprodeck.com/api/v7/cardinfo.php?misc=yes" > all-cards.json
//   3. node scripts/catalog-complete-plan.mjs . <dir> all-cards.json
//   4. provare ogni insert in una transazione annullata, poi applicarli; infine
//      analyze public.card_printings.
// Regole: inglesi da YGOPRODeck solo per set del registro (planCatalogIngest);
// IT/FR/DE/SP/PT ricavate dal gemello inglese con lo stesso numero (con lo
// stesso id carta Konami quando il registro ha entrambe); rarità non
// riconosciute dal guardiano del DB escluse.
globalThis.window ??= globalThis;
globalThis.localStorage ??= { getItem() { return null; }, setItem() {}, removeItem() {} };
import fs from 'node:fs';
import path from 'node:path';
const [root, dir, ygoFile] = process.argv.slice(2);
const { pathToFileURL } = await import('node:url');
const { planCatalogIngest } = await import(pathToFileURL(path.resolve(root, 'scripts/lib/catalog-ingest-plan.mjs')).href);
const read = name => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
const existing = read('existing.json'), registry = read('registry.json');
const cards = JSON.parse(fs.readFileSync(ygoFile, 'utf8')).data;

const key = row => [row.game, row.catalog_card_id, row.set_code, row.rarity, row.variant_id || ''].join('|');
const prefixOf = code => String(code).split('-')[0];
const registryPrefixes = new Set(registry.map(row => prefixOf(row.set_prefix)));
const registryByCode = new Map(registry.map(row => [row.set_prefix + row.print_number, row]));

// 1. Inglesi: solo set presenti nel registro Konami.
const scoped = cards.map(card => ({ ...card, card_sets: (card.card_sets || []).filter(set => registryPrefixes.has(prefixOf(String(set.set_code || '').toUpperCase()))) })).filter(card => card.card_sets.length);
const enPlan = planCatalogIngest(scoped, existing);
const imageFor = new Map(cards.map(card => [String(card.id), `https://images.ygoprodeck.com/images/cards/${card.id}.jpg`]));

// 2. Lingue europee: gemello inglese con lo stesso id carta Konami nel registro.
const known = new Set(existing.map(key));
for (const row of enPlan.rows) known.add(key(row));
const englishByCode = new Map();
for (const row of [...existing, ...enPlan.rows]) {
  if (!/-EN/.test(row.set_code)) continue;
  if (!englishByCode.has(row.set_code)) englishByCode.set(row.set_code, []);
  englishByCode.get(row.set_code).push(row);
}
const localized = [], skipped = { noEnglishTwinInRegistry: 0, konamiIdMismatch: 0, noEnglishPrinting: 0 };
for (const entry of registry) {
  const lang = entry.set_prefix.slice(-2);
  if (!['IT', 'FR', 'DE', 'SP', 'PT'].includes(lang)) continue;
  const base = prefixOf(entry.set_prefix), code = entry.set_prefix + entry.print_number, twin = `${base}-EN${entry.print_number}`;
  const twinEntry = registryByCode.get(twin);
  // Gemello inglese nel registro: deve avere lo stesso id carta Konami (verifica
  // forte; 0 discordanze su ~5.700 casi). Se il registro non ha l'inglese di
  // quel set, il gemello è la stampa YGOPRODeck con lo stesso numero.
  if (twinEntry && String(twinEntry.konami_card_id) !== String(entry.konami_card_id)) { skipped.konamiIdMismatch++; continue; }
  if (!twinEntry) skipped.noEnglishTwinInRegistry++;
  const english = englishByCode.get(twin);
  if (!english?.length) { skipped.noEnglishPrinting++; continue; }
  for (const source of english) {
    const row = { game: 'yugioh', catalog_card_id: source.catalog_card_id, card_name: source.card_name, set_code: code, set_name: source.set_name, rarity: source.rarity, variant_id: source.variant_id || '', source_ids: source.source_ids || [], localized_from: twin };
    if (known.has(key(row))) continue;
    known.add(key(row)); localized.push(row);
  }
}

// 3. Report di audit per set (prima/dopo) e SQL a blocchi.
// Etichette che il guardiano rarità del DB non riconosce o che sarebbero
// interpretate male (verificate con canonicalize_ygo_rarity_label): fuori.
// Grand Master Rare è nel canone dal 2026-10-13 (seriale per copia, non per stampa).
const BAD_RARITY = new Set(['2', '3', 'force-SMW', '10000 Secret Rare', 'New', 'Cr']);
const candidatesAll = [...enPlan.rows.map(row => ({ ...row, origin: 'ygoprodeck' })), ...localized.map(row => ({ ...row, origin: 'localized' }))];
const excludedRarity = {}; for (const row of candidatesAll) if (BAD_RARITY.has(row.rarity)) excludedRarity[row.rarity] = (excludedRarity[row.rarity] || 0) + 1;
const allNew = candidatesAll.filter(row => !BAD_RARITY.has(row.rarity));
const perSet = {};
for (const entry of registry) { const p = entry.set_prefix; (perSet[p] ??= { registry: 0, before: 0, after: 0 }).registry++; }
const has = new Set(existing.map(row => row.set_code));
const willHave = new Set([...has, ...allNew.map(row => row.set_code)]);
for (const entry of registry) { const code = entry.set_prefix + entry.print_number, p = perSet[entry.set_prefix]; if (has.has(code)) p.before++; if (willHave.has(code)) p.after++; }
const totals = Object.values(perSet).reduce((t, p) => ({ registry: t.registry + p.registry, before: t.before + p.before, after: t.after + p.after }), { registry: 0, before: 0, after: 0 });
const tally = {}; for (const d of enPlan.decisions) tally[d.classification + ':' + d.reason] = (tally[d.classification + ':' + d.reason] || 0) + 1;
const stillMissing = Object.entries(perSet).map(([prefix, p]) => ({ prefix, missing: p.registry - p.after })).filter(row => row.missing > 0).sort((a, b) => b.missing - a.missing);
fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify({ totals, excludedRarity, newRows: allNew.length, english: enPlan.rows.length, localized: localized.length, englishDecisions: tally, localizedSkipped: skipped, stillMissingTop: stillMissing.slice(0, 25), perSet }, null, 1));

// YGOPRODeck a volte restituisce entità HTML nei nomi (es. "Legendary 5D&apos;s Decks").
const decodeEntities = value => String(value ?? '').replace(/&#0*39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const esc = value => `'${String(value ?? '').replace(/'/g, "''")}'`;
const chunk = 2000; let files = 0;
for (let index = 0; index < allNew.length; index += chunk) {
  const values = allNew.slice(index, index + chunk).map(row => `(${esc(row.game)},${esc(row.catalog_card_id)},${esc(decodeEntities(row.card_name))},${esc(row.set_code)},${esc(decodeEntities(row.set_name))},${esc(row.rarity)},${esc(imageFor.get(String(row.source_ids?.[0] || row.catalog_card_id)) || '')},${esc(row.variant_id)})`);
  fs.writeFileSync(path.join(dir, `insert-${String(++files).padStart(2, '0')}.sql`), `insert into public.card_printings(game, catalog_card_id, card_name, set_code, set_name, rarity, image_url, variant_id)\nvalues\n${values.join(',\n')}\non conflict on constraint card_printings_identity_key do nothing;\n`);
}
console.log(JSON.stringify({ totals, excludedRarity, newRows: allNew.length, english: enPlan.rows.length, localized: localized.length, englishDecisions: tally, localizedSkipped: skipped, sqlFiles: files, stillMissingTop: stillMissing.slice(0, 8) }, null, 1));
