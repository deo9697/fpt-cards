// Verifica offline del normalizer OPTCG (nessuna rete, nessun DB): prova che
// gli esempi reali citati nel piano Fase 3 (OP01-001, P-017, EB01-003,
// don_183) restano printing distinte dopo la normalizzazione, invece di
// collassare regular/parallel/alt-art/DON sotto la stessa identità.
// Esegui: node scripts/onepiece-catalog-normalizer-smoke.mjs
import assert from 'node:assert/strict';
import {
  deriveSetCode, normalizeColorList, normalizeTraits, cleanNumber, extractTrigger,
  normalizeStandardCard, normalizeDonCard, identityKey
} from '../supabase/functions/onepiece-catalog-sync/normalizer.mjs';

const NOW = '2026-09-08T00:00:00.000Z';

// -- set_code derivato dal card number, non da set_id (OP-01 con trattino) --
assert.equal(deriveSetCode('OP01-016'), 'OP01');
assert.equal(deriveSetCode('ST04-016'), 'ST04');
assert.equal(deriveSetCode('EB01-003'), 'EB01');
assert.equal(deriveSetCode('P-017'), 'P');
console.log('PASS set_code derivato dal prefisso del card number');

// -- colori/traits sempre array, separatore / o , --
assert.deepEqual(normalizeColorList('Red'), ['Red']);
assert.deepEqual(normalizeColorList('Red/Green'), ['Red', 'Green']);
assert.deepEqual(normalizeColorList('Red, Green'), ['Red', 'Green']);
assert.deepEqual(normalizeColorList(''), []);
assert.deepEqual(normalizeTraits('Straw Hat Crew/Animal'), ['Straw Hat Crew', 'Animal']);
console.log('PASS colori e traits normalizzati come array');

// -- numeri tollerante: mai un reject, solo il campo torna null --
assert.equal(cleanNumber('2000'), 2000);
assert.equal(cleanNumber(2000), 2000);
assert.equal(cleanNumber(''), null);
assert.equal(cleanNumber(null), null);
assert.equal(cleanNumber(undefined), null);
assert.equal(cleanNumber('N/A'), null);
assert.equal(cleanNumber('-'), null);
console.log('PASS cleanNumber non scarta mai la carta per un campo numerico mancante/sporco');

// -- [Trigger] estratto solo se presente nel card_text --
assert.equal(extractTrigger('[Trigger] Draw 1 card.'), 'Draw 1 card.');
assert.equal(extractTrigger('On Play Rest up to 1 of your opponent\'s Characters.'), '');
assert.equal(extractTrigger(''), '');
console.log('PASS estrazione [Trigger] solo quando presente nel testo');

// -- OP01-001 regular vs OP01-001_p1 alt art: stesso catalog_card_id, --
// -- variant_id diverso, quindi identity_key diversa. --
const op01RegularRaw = { card_set_id: 'OP01-001', card_image_id: 'OP01-001', card_name: 'Monkey.D.Luffy', card_color: 'Red', card_type: 'Leader', rarity: 'L', set_name: 'Romance Dawn', card_image: 'https://example.test/op01-001.png' };
const op01AltRaw = { ...op01RegularRaw, card_image_id: 'OP01-001_p1' };
const op01Regular = normalizeStandardCard(op01RegularRaw, NOW);
const op01Alt = normalizeStandardCard(op01AltRaw, NOW);
assert.equal(op01Regular.catalog_card_id, 'OP01-001');
assert.equal(op01Regular.variant_id, 'OP01-001');
assert.equal(op01Regular.set_code, 'OP01');
assert.equal(op01Alt.catalog_card_id, 'OP01-001');
assert.equal(op01Alt.variant_id, 'OP01-001_p1');
assert.notEqual(identityKey(op01Regular), identityKey(op01Alt), 'regular e alt art non devono collassare sulla stessa identità');
console.log('PASS OP01-001 regular e OP01-001_p1 restano printing distinte');

// -- P-017 promo regular vs P-017_pr1: set_code condiviso 'P', non un set --
// -- diverso per ogni singolo numero di promo. --
const promoRegularRaw = { card_set_id: 'P-017', card_image_id: 'P-017', set_id: 'P', set_name: 'One Piece Promotion Cards', card_name: 'Nami', rarity: 'PR', card_image: 'https://example.test/p-017.png' };
const promoAltRaw = { ...promoRegularRaw, card_image_id: 'P-017_pr1' };
const promoRegular = normalizeStandardCard(promoRegularRaw, NOW);
const promoAlt = normalizeStandardCard(promoAltRaw, NOW);
assert.equal(promoRegular.set_code, 'P');
assert.equal(promoRegular.set_name, 'One Piece Promotion Cards');
assert.equal(promoAlt.variant_id, 'P-017_pr1');
assert.notEqual(identityKey(promoRegular), identityKey(promoAlt));
// set_name mancante dall'API per un promo: fallback al nome unificato, non stringa vuota.
const promoNoSetName = normalizeStandardCard({ ...promoRegularRaw, set_name: '' }, NOW);
assert.equal(promoNoSetName.set_name, 'One Piece Promotion Cards');
console.log('PASS promo P-017/P-017_pr1 condividono un unico set_code senza collassare la printing');

// -- EB01-003 / EB01-003_pr2 (Extra Booster) --
const eb01RegularRaw = { card_set_id: 'EB01-003', card_image_id: 'EB01-003', card_name: 'Trafalgar Law', rarity: 'SR', set_name: 'Memorial Collection' };
const eb01AltRaw = { ...eb01RegularRaw, card_image_id: 'EB01-003_pr2' };
const eb01Regular = normalizeStandardCard(eb01RegularRaw, NOW);
const eb01Alt = normalizeStandardCard(eb01AltRaw, NOW);
assert.equal(eb01Regular.set_code, 'EB01');
assert.notEqual(identityKey(eb01Regular), identityKey(eb01Alt));
console.log('PASS EB01-003/EB01-003_pr2 restano printing distinte');

// -- DON!! (don_183): niente card_set_id/set_id nel payload reale --
const donRaw = { card_image_id: 'don_183', card_name: 'DON!! Card (Egghead)', card_text: 'Your Turn +1000', rarity: 'DON!!', card_type: 'DON!!', card_image: 'https://example.test/don-183.png' };
const don = normalizeDonCard(donRaw, NOW);
assert.equal(don.catalog_card_id, 'don_183');
assert.equal(don.variant_id, 'don_183');
assert.equal(don.set_code, 'DON');
console.log('PASS DON!! (don_183) normalizzato con set_code fisso e identità propria');

// -- Due don_id diversi non devono mai collassare sulla stessa riga. --
const donOther = normalizeDonCard({ ...donRaw, card_image_id: 'don_1', card_name: 'DON!! Card' }, NOW);
assert.notEqual(identityKey(don), identityKey(donOther));
console.log('PASS due carte DON!! diverse restano identità separate');

// -- Record senza identità utilizzabile viene scartato (skipped), non --
// -- inserito con dati vuoti. --
assert.equal(normalizeStandardCard({ card_set_id: '', card_name: 'Senza ID' }, NOW), null);
assert.equal(normalizeStandardCard({ card_set_id: 'OP01-999', card_name: '' }, NOW), null);
assert.equal(normalizeDonCard({ card_image_id: '', card_name: 'Senza ID' }, NOW), null);
console.log('PASS carte senza catalog_card_id o card_name vengono scartate, non salvate vuote');

// -- Stesso raw record normalizzato due volte (simula la stessa carta --
// -- comparsa sia in allSetCards sia in allPromos, Fase 3.9): stessa --
// -- identity_key, quindi il dedupe locale la collassa correttamente in --
// -- una singola riga upsert invece di farla arrivare due volte nello --
// -- stesso batch (che Postgres rifiuterebbe). --
const duplicateA = normalizeStandardCard(op01RegularRaw, NOW);
const duplicateB = normalizeStandardCard({ ...op01RegularRaw }, NOW);
assert.equal(identityKey(duplicateA), identityKey(duplicateB));
assert.deepEqual(duplicateA, duplicateB);
console.log('PASS stesso raw normalizzato due volte produce la stessa identity_key (dedupe sicuro)');

console.log('\nTutti i controlli del normalizer One Piece sono passati.');
