// Controllo automatico dei set nuovi (supabase/functions/catalog-new-sets/plan.ts,
// 2026-10-24): entrano solo stampe su cui YGOPRODeck, YGOResources (printcode
// per lingua) e l'indice nomi Konami concordano. Dati finti, nessuna rete.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
if (!process.execArgv.includes('--experimental-strip-types')) {
  const child = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url)], { stdio: 'inherit' });
  process.exit(child.status ?? 1);
}
const { planNewSet, missingCodes, unlistedEnglishNumbers, konamiIdsByName, identityKey } = await import('../supabase/functions/catalog-new-sets/plan.ts');

const card = (id, name, sets) => ({ id, name, card_sets: sets.map(([set_code, set_rarity]) => ({ set_code, set_rarity })) });
const ygoCards = [
  card(1, 'Swiftwind Panther Warrior', [['NEWS-EN001', 'Super Rare'], ['NEWS-EN001', 'Starlight Rare'], ['OLD1-EN050', 'Common']]),
  card(2, 'Crowned Siclavee', [['NEWS-EN002', 'Common']]),
  card(3, 'Impostor', [['NEWS-EN003', 'Common']]),
  card(4, 'Fresh Promo', [['NEWS-EN004', 'New']]),
  card(5, 'Twin Mismatch', [['NEWS-EN005', 'Rare']])
];
const printcodes = {
  EN: { '001': 11, '002': 12, '003': 13, '004': 14, '005': 15, SP1: 21 },
  IT: { '001': 11, '002': 12, '005': 99, SP1: 21 },
  DE: { '001': 11 }
};
const namesToKonami = konamiIdsByName({ 'Swiftwind Panther Warrior': [11], 'Crowned Siclavee': [12], 'Real Card 3': [13], 'Fresh Promo': [14], 'Twin Mismatch': [15], 'Dark Time Wizard': [21, 7] });
const allowedRarities = new Set(['Super Rare', 'Starlight Rare', 'Common', 'Rare', 'Secret Rare']);
const existing = new Set([identityKey({ catalog_card_id: '2', set_code: 'NEWS-IT002', rarity: 'Common', variant_id: '' })]);
const extras = { SP1: { card: { id: 40235813, name: 'Dark Time Wizard' }, rarities: ['Secret Rare'] } };

assert.deepEqual(unlistedEnglishNumbers('NEWS', ygoCards, printcodes), ['SP1'], 'stampa speciale non elencata da YGOPRODeck');
const plan = planNewSet({ set: 'NEWS', setName: 'News &amp; Views', ygoCards, printcodes, namesToKonami, existing, allowedRarities, extras });
assert.deepEqual(plan.rows.map(row => `${row.set_code} ${row.rarity}`).sort(), [
  'NEWS-DE001 Starlight Rare', 'NEWS-DE001 Super Rare',
  'NEWS-EN001 Starlight Rare', 'NEWS-EN001 Super Rare', 'NEWS-EN002 Common', 'NEWS-EN005 Rare', 'NEWS-ENSP1 Secret Rare',
  'NEWS-IT001 Starlight Rare', 'NEWS-IT001 Super Rare', 'NEWS-ITSP1 Secret Rare'
], 'solo stampe verificate; IT002 già presente; altri set ignorati');
const reasons = plan.issues.map(issue => `${issue.code}: ${issue.reason}`).join('\n');
assert.match(reasons, /NEWS-EN003: "Impostor" non corrisponde/, 'nome diverso dall\'id Konami: fuori');
assert.match(reasons, /NEWS-EN004: rarità "New" non riconosciuta/, '"New" mai trasformata in Common');
assert.match(reasons, /NEWS-IT005: id Konami 99 diverso/, 'traduzione con id Konami diverso: fuori');
assert.ok(plan.rows.every(row => row.set_name === 'News & Views' && row.variant_id === ''), 'nome set decodificato');
assert.equal(plan.rows.find(row => row.set_code === 'NEWS-ITSP1').catalog_card_id, '40235813', 'stampa speciale con id YGOPRODeck reale');

// "New" su YGOPRODeck ma inglese già nel catalogo (rarità dalla scheda Konami):
// le traduzioni prendono la rarità del catalogo, mai Common inventato.
const withCatalog = new Set([identityKey({ catalog_card_id: '4', set_code: 'NEWS-EN004', rarity: 'Grand Master Rare', variant_id: '' })]);
const promo = planNewSet({ set: 'NEWS', setName: 'x', ygoCards, printcodes: { EN: printcodes.EN, IT: { '004': 14 } }, namesToKonami, existing: withCatalog, allowedRarities, extras: {} });
assert.deepEqual(promo.rows.filter(row => row.catalog_card_id === '4').map(row => `${row.set_code} ${row.rarity}`), ['NEWS-IT004 Grand Master Rare'], 'traduzione dalla rarità già in catalogo');

// Idempotenza e rilevamento dei buchi.
const after = new Set([...existing, ...plan.rows.map(identityKey)]);
assert.equal(planNewSet({ set: 'NEWS', setName: 'x', ygoCards, printcodes, namesToKonami, existing: after, allowedRarities, extras }).rows.length, 0, 'secondo run: niente');
assert.deepEqual(missingCodes('NEWS', printcodes, new Set(['NEWS-EN001', 'NEWS-IT001', 'NEWS-DE001'])).length, 8, 'codici mancanti per lingua');
assert.deepEqual(planNewSet({ set: 'NEWS', setName: 'x', ygoCards, printcodes: { IT: printcodes.IT }, namesToKonami }).rows, [], 'senza inglese su YGOResources: nessuna riga');
console.log('PASS catalog-new-sets plan: tre fonti concordi · "New" escluso · traduzioni solo con stesso id Konami · stampe speciali · idempotente');
