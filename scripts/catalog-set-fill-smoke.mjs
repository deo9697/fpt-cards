// Riempimento catalogo per un set nuovo (2026-10-24, caso reale BETB): solo
// righe confermate da YGOPRODeck + scheda Konami + registro Konami. Dati finti.
import assert from 'node:assert/strict';
import { planSetFill, setFillSql } from './lib/catalog-set-fill.mjs';

const card = (id, name, sets) => ({ id, name, card_sets: sets.map(([set_code, set_rarity]) => ({ set_code, set_rarity })) });
const ygoCards = [
  card(1, 'Swiftwind Panther Warrior', [['TEST-EN001', 'Super Rare'], ['TEST-EN001', 'Starlight Rare']]),
  card(2, 'Crowned Siclavee', [['TEST-EN002', 'Common']]),
  card(3, 'Wrong Name Card', [['TEST-EN003', 'Common']]),
  card(4, 'Rarity Drift', [['TEST-EN004', 'Rare']]),
  card(5, 'Mismatched Twin', [['TEST-EN005', 'Common']])
];
const konami = {
  'TEST-EN001': { konamiId: '101', cardName: 'Swiftwind Panther Warrior', rarities: ['Starlight Rare', 'Super Rare'] },
  'TEST-EN002': { konamiId: '102', cardName: 'Crowned Siclavee', rarities: ['Common'] },
  'TEST-EN003': { konamiId: '103', cardName: 'Another Card', rarities: ['Common'] },
  'TEST-EN004': { konamiId: '104', cardName: 'Rarity Drift', rarities: ['Super Rare'] },
  'TEST-EN005': { konamiId: '105', cardName: 'Mismatched Twin', rarities: ['Common'] },
  'TEST-ENSP1': { konamiId: '201', cardName: 'Dark Time Wizard', rarities: ['Secret Rare'] },
  'TEST-ENSP2': { konamiId: '202', cardName: 'Unknown Upstream', rarities: ['Secret Rare'] }
};
const registry = [
  ...['IT', 'PT'].flatMap(language => ['001', '002'].map((number, index) => ({ set_prefix: `TEST-${language}`, print_number: number, konami_card_id: String(101 + index) }))),
  { set_prefix: 'TEST-IT', print_number: '005', konami_card_id: '999' },
  { set_prefix: 'TEST-IT', print_number: 'SP1', konami_card_id: '201' },
  { set_prefix: 'TEST-IT', print_number: 'SP2', konami_card_id: '202' }
];
const extraCards = { 'TEST-ENSP1': { id: 40235813, name: 'Dark Time Wizard' } };
const existing = [{ catalog_card_id: '2', set_code: 'TEST-IT002', rarity: 'Common', variant_id: '' }];
const plan = planSetFill({ setCode: 'TEST', setName: 'Legendary 5D&apos;s Decks', ygoCards, registry, existing, konami, extraCards });
const codes = plan.rows.map(row => `${row.set_code} ${row.rarity}`).sort();

assert.deepEqual(codes, [
  'TEST-EN001 Starlight Rare', 'TEST-EN001 Super Rare', 'TEST-EN002 Common', 'TEST-EN005 Common',
  'TEST-ENSP1 Secret Rare', 'TEST-IT001 Starlight Rare', 'TEST-IT001 Super Rare', 'TEST-ITSP1 Secret Rare',
  'TEST-PT001 Starlight Rare', 'TEST-PT001 Super Rare', 'TEST-PT002 Common'
], 'solo righe confermate; la IT002 già nel catalogo non si ripete');
const reasons = Object.fromEntries(plan.issues.map(issue => [issue.code, issue.reason]));
assert.match(reasons['TEST-EN003'], /nome diverso/, 'nome Konami diverso: fuori');
assert.match(reasons['TEST-EN004'], /rarità diverse/, 'rarità diverse da Konami: fuori');
assert.match(reasons['TEST-IT005'], /id Konami 999 diverso/, 'traduzione con id Konami diverso: fuori');
assert.match(reasons['TEST-ENSP2'], /non trovata su YGOPRODeck/, 'stampa speciale senza carta YGOPRODeck: fuori, mai un id inventato');
assert.equal(plan.rows.find(row => row.set_code === 'TEST-ITSP1').catalog_card_id, '40235813', 'stampa speciale: id YGOPRODeck reale per nome esatto');
assert.ok(plan.rows.every(row => row.set_name === "Legendary 5D's Decks"), 'entità HTML decodificate nel nome set');
assert.match(setFillSql(plan.rows), /on conflict on constraint card_printings_identity_key do nothing;\n$/, 'SQL idempotente');
assert.equal(planSetFill({ setCode: 'TEST', setName: 'x', ygoCards, registry, existing: plan.rows.concat(existing), konami, extraCards }).rows.length, 0, 'secondo run: nessuna riga nuova');
console.log('PASS catalog set fill: inglese confermato da Konami · traduzioni solo con stesso id Konami · stampe speciali con id reale · idempotente');
