// Aggiunge al catalogo un set Yu-Gi-Oh! appena uscito (2026-10-24, primo uso:
// Beyond the Brave / BETB). Non scrive sul DB: genera insert.sql idempotente
// (on conflict do nothing) + report.json da rivedere, provare e applicare.
//
// Uso:
//   1. <dir>/registry.json = select set_prefix,print_number,konami_card_id::text
//                            from ygo_printcode_entries where set_prefix like '<SET>-%'
//      <dir>/existing.json = select catalog_card_id,set_code,rarity,coalesce(variant_id,'') variant_id
//                            from card_printings where game='yugioh' and set_code like '<SET>-%'
//   2. node scripts/catalog-add-set.mjs <SET> <dir>
//   3. provare insert.sql in una transazione annullata, poi applicarlo e
//      lanciare analyze public.card_printings.
// Le schede Konami arrivano dalla funzione konami-card-rarities (una alla
// volta, con pausa) e restano in <dir>/konami.json per i run successivi.
// Regole di verifica: vedi scripts/lib/catalog-set-fill.mjs.
globalThis.window ??= globalThis;
globalThis.localStorage ??= { getItem() { return null; }, setItem() {}, removeItem() {} };
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const { planSetFill, setFillSql } = await import(pathToFileURL(path.resolve('scripts/lib/catalog-set-fill.mjs')).href);
const { canonicalCatalogCardId } = await import(pathToFileURL(path.resolve('js/cards.js')).href);

const [setArg, dir] = process.argv.slice(2);
if (!setArg || !dir) { console.error('uso: node scripts/catalog-add-set.mjs <SET> <dir>'); process.exit(2); }
const set = setArg.toUpperCase();
const KONAMI_FN = 'https://gonycawupahawocqafcf.supabase.co/functions/v1/konami-card-rarities';
const YGO = 'https://db.ygoprodeck.com/api/v7';
const read = name => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
const getJson = async url => { const response = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (F.P.T Cards catalog)' } }); if (!response.ok) throw new Error(`${response.status} ${url}`); return response.json(); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

const registry = read('registry.json'), existing = read('existing.json');
const info = (await getJson(`${YGO}/cardsets.php`)).find(row => String(row.set_code).toUpperCase() === set);
if (!info) throw new Error(`set ${set} sconosciuto a YGOPRODeck`);
const ygoCards = (await getJson(`${YGO}/cardinfo.php?cardset=${encodeURIComponent(info.set_name)}`).catch(() => ({ data: [] }))).data || [];

const konamiFile = path.join(dir, 'konami.json');
const konami = fs.existsSync(konamiFile) ? JSON.parse(fs.readFileSync(konamiFile, 'utf8')) : {};
const englishCodes = new Set(ygoCards.flatMap(card => (card.card_sets || []).map(row => String(row.set_code || '').toUpperCase())).filter(code => code.startsWith(`${set}-EN`)));
for (const number of new Set(registry.map(row => row.print_number))) englishCodes.add(`${set}-EN${number}`);
for (const code of [...englishCodes].sort()) {
  if (konami[code]) continue;
  const response = await fetch(`${KONAMI_FN}?setCode=${encodeURIComponent(code)}`);
  konami[code] = response.ok ? await response.json() : { error: response.status };
  fs.writeFileSync(konamiFile, JSON.stringify(konami, null, 1));
  await pause(700);
}

// Stampe del registro che YGOPRODeck non elenca nel set: carta cercata per nome esatto.
const listed = new Set(ygoCards.flatMap(card => (card.card_sets || []).map(row => String(row.set_code || '').toUpperCase())));
const extraCards = {};
for (const code of englishCodes) {
  if (listed.has(code) || !konami[code]?.cardName) continue;
  const found = (await getJson(`${YGO}/cardinfo.php?name=${encodeURIComponent(konami[code].cardName)}`).catch(() => ({ data: [] }))).data?.[0];
  if (found) extraCards[code] = found;
}

const plan = planSetFill({ setCode: set, setName: info.set_name, ygoCards, registry, existing, konami, extraCards, canonicalId: id => canonicalCatalogCardId(id, 'yugioh') || String(id) });
fs.writeFileSync(path.join(dir, 'insert.sql'), setFillSql(plan.rows));
const byLanguage = plan.rows.reduce((total, row) => { const language = row.set_code.slice(set.length + 1, set.length + 3); total[language] = (total[language] || 0) + 1; return total; }, {});
const report = { set, setName: info.set_name, ygoprodeckCards: ygoCards.length, englishCodes: plan.englishCodes, registryCodes: plan.registryCodes, existingRows: existing.length, newRows: plan.rows.length, byLanguage, issues: plan.issues };
fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 1));
console.log(JSON.stringify(report, null, 1));
