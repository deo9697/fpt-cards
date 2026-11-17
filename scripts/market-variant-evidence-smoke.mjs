// Unit smoke for supabase/functions/_shared/variant-evidence.js (2026-11-17).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decideVariantsByEvidence, learnPositions, evidenceNote, summarizeEvidence } from '../supabase/functions/_shared/variant-evidence.js';
import { buildRarityFamilies, inferVariantsByPriceOrder } from '../supabase/functions/_shared/variant-price-order.js';

const prices = new Map(Object.entries({
  // MAMO-EN018: Ultra / Starlight / Grand Master + one unknown extra version
  904602: 1.79, 904603: 28.03, 904604: 154.19, 904605: 4550,
  // STBL-IT038: Ultra 9.05 vs Ultimate 16.70
  244291: 9.05, 244292: 16.7,
  // RA04 near-equal prices
  820372: 2.58, 820461: 2.75, 820543: 3.15,
  // cheap commons: 0.04 vs 0.05 too close
  1: 0.04, 2: 0.05,
}));
const priceOf = id => prices.get(String(id)) ?? null;
const families = buildRarityFamilies([
  { catalog_card_id: 'witch', set_code: 'MAMO-EN018', rarity: 'Ultra Rare' }, { catalog_card_id: 'witch', set_code: 'MAMO-EN018', rarity: 'Starlight Rare' }, { catalog_card_id: 'witch', set_code: 'MAMO-EN018', rarity: 'Grand Master Rare' },
  { catalog_card_id: 'arcanite', set_code: 'STBL-EN038', rarity: 'Ultra Rare' }, { catalog_card_id: 'arcanite', set_code: 'STBL-IT038', rarity: 'Ultimate Rare' },
  { catalog_card_id: 'fiend', set_code: 'RA04-EN049', rarity: 'Super Rare' }, { catalog_card_id: 'fiend', set_code: 'RA04-EN049', rarity: 'Ultra Rare' }, { catalog_card_id: 'fiend', set_code: 'RA04-EN049', rarity: 'Secret Rare' },
  { catalog_card_id: 'common', set_code: 'L26D-EN001', rarity: 'Common' }, { catalog_card_id: 'common', set_code: 'L26D-EN001', rarity: 'Rare' },
]);
const t = (printingId, catalogCardId, setCode, rarity, ids) => ({ printingId, catalogCardId, setCode, rarity, candidateProductIds: ids });
const decide = (targets, extra = {}) => decideVariantsByEvidence({ targets, families, priceOf, ...extra });
const one = (targets, extra) => decide(targets, extra)[0];

// 1) Two independent clues agreeing → auto (tier + base, IT code uses the EN family).
let d = one([t('a', 'arcanite', 'STBL-IT038', 'Ultra Rare', ['244292', '244291'])]);
assert.equal(d.decision, 'auto'); assert.equal(d.productId, '244291'); assert.deepEqual(Object.keys(d.signals).sort(), ['base', 'tier']);
assert.equal(evidenceNote(d), 'ordine dei prezzi della carta + rarità base, versione più economica');
console.log('PASS due indizi d\'accordo → conferma automatica (famiglia di rarità da tutte le lingue)');

// 2) A single clue → suggestion only (base with one unknown extra version, far cheaper).
d = one([t('b', 'witch', 'MAMO-EN018', 'Ultra Rare', ['904602', '904603', '904604', '904605'])]);
assert.equal(d.decision, 'suggest'); assert.equal(d.productId, '904602'); assert.deepEqual(Object.keys(d.signals), ['base']);
console.log('PASS un solo indizio → solo suggerimento (versione extra sconosciuta tollerata se molto più cara)');

// 3) Learning: one single-card confirmation in the set + base → auto; alone → suggest.
const confirmMamo = [{ setCode: 'MAMO-EN005', rarity: 'Ultra Rare', candidateProductIds: ['904550', '904551', '904552', '904553'], productId: '904550' }];
d = one([t('b', 'witch', 'MAMO-EN018', 'Ultra Rare', ['904602', '904603', '904604', '904605'])], { confirmations: confirmMamo });
assert.equal(d.decision, 'auto'); assert.deepEqual(Object.keys(d.signals).sort(), ['base', 'learned']);
d = one([t('c', 'unknown', 'MAMO-EN020', 'Ultra Rare', ['10', '11', '12', '13'])], { confirmations: confirmMamo });
assert.equal(d.decision, 'suggest'); assert.equal(d.productId, '10');
d = one([t('c', 'unknown', 'MAMO-EN020', 'Ultra Rare', ['10', '11', '12', '13'])], { confirmations: [...confirmMamo, { setCode: 'MAMO-IT007', rarity: 'Ultra Rare', candidateProductIds: ['20', '21', '22', '23'], productId: '20' }] });
assert.equal(d.decision, 'auto', 'due conferme concordi bastano da sole'); assert.equal(d.learnedCount, 2);
console.log('PASS apprendimento dal set: 1 conferma + indizio → auto, 1 sola → suggerimento, 2 concordi → auto');

// 4) Conflicts never decide.
d = one([t('c', 'unknown', 'MAMO-EN020', 'Ultra Rare', ['10', '11', '12', '13'])], { confirmations: [...confirmMamo, { setCode: 'MAMO-EN021', rarity: 'Ultra Rare', candidateProductIds: ['30', '31', '32', '33'], productId: '31' }] });
assert.equal(d.decision, 'conflict'); assert.equal(d.productId, null);
d = one([t('a', 'arcanite', 'STBL-IT038', 'Ultra Rare', ['244291', '244292'])], { confirmations: [{ setCode: 'STBL-EN001', rarity: 'Ultra Rare', candidateProductIds: ['5', '6'], productId: '6' }] });
assert.equal(d.decision, 'conflict', 'conferme del set e prezzi in disaccordo → nessuna decisione');
console.log('PASS conflitti: conferme discordi o indizi in disaccordo → nessuna decisione');

// 5) Prices too close / ladder incomplete → nothing.
d = one([t('e', 'fiend', 'RA04-IT049', 'Ultra Rare', ['820372', '820461', '820543'])]);
assert.equal(d.decision, 'none');
d = one([t('f', 'common', 'L26D-EN001', 'Common', ['1', '2'])]);
assert.equal(d.decision, 'none', '0,04 vs 0,05 € non è un indizio');
console.log('PASS prezzi troppo vicini o scala incompleta → nessun indizio');

// 6) Verified set template wins alone; a well-backed set rule too.
d = one([t('e', 'fiend', 'RA04-IT049', 'Ultra Rare', ['820372', '820461', '820543'])], { templateAssignments: [{ printingId: 'e', productId: '820461', template: true }] });
assert.equal(d.decision, 'auto'); assert.equal(d.productId, '820461'); assert.equal(evidenceNote(d), 'template del set verificato');
d = one([t('e', 'fiend', 'RA04-IT049', 'Ultra Rare', ['820372', '820461', '820543'])], { priceOrderAssignments: [{ printingId: 'e', productId: '820461', decisiveCards: 3, ownEvidence: false }] });
assert.equal(d.decision, 'auto', 'regola prezzi del set sostenuta da 3 carte = come prima del motore');
d = one([t('e', 'fiend', 'RA04-IT049', 'Ultra Rare', ['820372', '820461', '820543'])], { priceOrderAssignments: [{ printingId: 'e', productId: '820461', decisiveCards: 1, ownEvidence: true }] });
assert.equal(d.decision, 'none', 'una regola decisa solo dalla carta stessa non è un secondo parere');
console.log('PASS template verificato e regola del set ben sostenuta decidono da soli; regola auto-referenziale ignorata');

// 7) learnPositions ignores confirmations without the chosen product or with < 2 versions.
const learned = learnPositions([{ setCode: 'X-1', rarity: 'Rare', candidateProductIds: ['1'], productId: '1' }, { setCode: 'X-2', rarity: 'Rare', candidateProductIds: ['1', '2'], productId: '9' }]);
assert.equal(learned.size, 0);
console.log('PASS apprendimento: scarta conferme senza versioni multiple o con prodotto estraneo');

// 8) Real snapshot (2026-11-17, read-only export): 80 cards in the queue.
const snapshot = JSON.parse(readFileSync(new URL('./fixtures/market-variant-evidence-snapshot-2026-11-17.json', import.meta.url), 'utf8'));
const realFamilies = buildRarityFamilies(snapshot.printings), realPrice = id => snapshot.prices[id] ?? null;
const realTargets = snapshot.targets;
const order = inferVariantsByPriceOrder({ targets: realTargets, families: realFamilies, priceOf: realPrice });
const real = decideVariantsByEvidence({ targets: realTargets, families: realFamilies, priceOf: realPrice, priceOrderAssignments: order.assignments });
const counts = summarizeEvidence(real);
assert.equal(counts.conflict, 0, 'nessun conflitto sui dati reali');
assert(counts.auto >= 2 && counts.suggest >= 20, `dati reali: attesi ≥2 automatiche e ≥20 suggerimenti, trovati ${JSON.stringify(counts)}`);
const stbl = real.find(row => realTargets.find(x => x.printingId === row.printingId).setCode === 'STBL-IT038');
assert.equal(stbl.productId, '244291', 'STBL-IT038 Ultra Rare = la versione da 9,05 €');
console.log(`PASS dati reali (80 carte in coda): ${JSON.stringify(counts)}`);
console.log('market-variant-evidence-smoke: OK');
