// Varianti esatte automatiche (2026-10-25): quale prodotto Cardmarket è quale
// rarità quando una carta ha più prodotti nello stesso set. Caso reale: BETB-IT013
// Starlight prezzata come la Secret (minimo tra 914739 e 915990).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inferVariantsByPriceOrder, resolveBySetTemplates, buildRarityFamilies, guidePrice, familyKey } from '../supabase/functions/_shared/variant-price-order.js';

const test = (name, fn) => { fn(); console.log(`PASS ${name}`); };
const target = (printingId, setCode, rarity, catalogCardId, ids) => ({ printingId, setCode, rarity, catalogCardId, candidateProductIds: ids });
const fam = rows => buildRarityFamilies(rows.map(([catalog_card_id, set_code, rarity]) => ({ catalog_card_id, set_code, rarity })));
const prices = obj => id => obj[id] ?? null;

test('BETB-IT013 Starlight → prodotto più caro e più recente (915990), Secret → 914739', () => {
  const families = fam([['64603351', 'BETB-EN013', 'Secret Rare'], ['64603351', 'BETB-IT013', 'Starlight Rare'], ['64603351', 'BETB-IT013', 'Secret Rare']]);
  const out = inferVariantsByPriceOrder({
    targets: [target('star', 'BETB-IT013', 'Starlight Rare', '64603351', ['915990', '914739']), target('sec', 'BETB-IT013', 'Secret Rare', '64603351', ['914739', '915990'])],
    families, priceOf: prices({ 914739: 2.14, 915990: 12.37 }),
  });
  const by = new Map(out.assignments.map(a => [a.printingId, a.productId]));
  assert.equal(by.get('star'), '915990');
  assert.equal(by.get('sec'), '914739');
});

test('regola del set applicata anche alle carte con prezzi troppo vicini (ordine idProduct)', () => {
  const families = fam([['1', 'CORI-EN001', 'Ultra Rare'], ['1', 'CORI-EN001', 'Starlight Rare'], ['2', 'CORI-EN002', 'Ultra Rare'], ['2', 'CORI-EN002', 'Starlight Rare']]);
  const out = inferVariantsByPriceOrder({
    targets: [target('a', 'CORI-EN001', 'Starlight Rare', '1', ['100', '200']), target('b', 'CORI-EN002', 'Starlight Rare', '2', ['300', '400'])],
    // carta 2: prezzi quasi uguali (nessuna evidenza propria) → segue la regola: più recente = Starlight
    families, priceOf: prices({ 100: 1, 200: 40, 300: 5, 400: 5.5 }),
  });
  const b = out.assignments.find(a => a.printingId === 'b');
  assert.equal(b.productId, '400');
  assert.equal(b.ownEvidence, false);
  assert.equal(b.decisiveCards, 1);
});

test('set con ordine invertito (es. BLMM): segue l\'evidenza, non un ordine fisso', () => {
  const families = fam([['1', 'BLMM-EN001', 'Secret Rare'], ['1', 'BLMM-EN001', 'Starlight Rare'], ['2', 'BLMM-EN002', 'Secret Rare'], ['2', 'BLMM-EN002', 'Starlight Rare']]);
  const out = inferVariantsByPriceOrder({
    targets: [target('a', 'BLMM-EN001', 'Starlight Rare', '1', ['100', '200']), target('b', 'BLMM-EN002', 'Starlight Rare', '2', ['300', '400'])],
    families, priceOf: prices({ 100: 90, 200: 3, 300: 4, 400: 4.2 }),
  });
  assert.equal(out.assignments.find(a => a.printingId === 'a').productId, '100');
  assert.equal(out.assignments.find(a => a.printingId === 'b').productId, '300');
});

test('evidenze in conflitto nello stesso set → nessuna assegnazione (resta la stima)', () => {
  const families = fam([['1', 'XXXX-EN001', 'Ultra Rare'], ['1', 'XXXX-EN001', 'Ultimate Rare'], ['2', 'XXXX-EN002', 'Ultra Rare'], ['2', 'XXXX-EN002', 'Ultimate Rare']]);
  const out = inferVariantsByPriceOrder({
    targets: [target('a', 'XXXX-EN001', 'Ultimate Rare', '1', ['100', '200']), target('b', 'XXXX-EN002', 'Ultimate Rare', '2', ['300', '400'])],
    families, priceOf: prices({ 100: 1, 200: 30, 300: 30, 400: 1 }),
  });
  assert.equal(out.assignments.length, 0);
  assert.equal(out.skipped.conflicting_evidence, 2);
});

test('carte da centesimi: ×2 non basta senza scarto minimo in euro', () => {
  const families = fam([['1', 'SP14-EN001', 'Common'], ['1', 'SP14-EN001', 'Starfoil Rare']]);
  const out = inferVariantsByPriceOrder({ targets: [target('a', 'SP14-EN001', 'Starfoil Rare', '1', ['100', '200'])], families, priceOf: prices({ 100: 0.02, 200: 0.1 }) });
  assert.equal(out.assignments.length, 0);
  assert.equal(out.skipped.no_decisive_evidence, 1);
});

test('rarità del catalogo ≠ numero prodotti, rarità di pari valore, rarità sconosciuta → saltate', () => {
  const families = fam([['1', 'AAAA-EN001', 'Ultra Rare'], ['2', 'BBBB-EN001', 'Rare'], ['2', 'BBBB-EN001', 'Starfoil Rare'], ['3', 'CCCC-EN001', 'Rare'], ['3', 'CCCC-EN001', 'Fantasy Rare']]);
  const out = inferVariantsByPriceOrder({
    targets: [target('a', 'AAAA-EN001', 'Ultra Rare', '1', ['1', '2']), target('b', 'BBBB-EN001', 'Rare', '2', ['3', '4']), target('c', 'CCCC-EN001', 'Rare', '3', ['5', '6'])],
    families, priceOf: prices({ 1: 1, 2: 50, 3: 1, 4: 50, 5: 1, 6: 50 }),
  });
  assert.equal(out.assignments.length, 0);
  assert.deepEqual(out.skipped, { rarity_count_mismatch: 1, rarity_value_tie: 1, unknown_rarity_value: 1 });
});

test('3 rarità: serve che tutti i prodotti siano nettamente distinti', () => {
  const families = fam([['1', 'L26D-EN001', 'Common'], ['1', 'L26D-EN001', 'Secret Rare'], ['1', 'L26D-EN001', 'Starlight Rare']]);
  const ok = inferVariantsByPriceOrder({ targets: [target('a', 'L26D-EN001', 'Secret Rare', '1', ['10', '20', '30'])], families, priceOf: prices({ 10: 0.5, 20: 60, 30: 4 }) });
  assert.equal(ok.assignments[0].productId, '30');
  const close = inferVariantsByPriceOrder({ targets: [target('a', 'L26D-EN001', 'Secret Rare', '1', ['10', '20', '30'])], families, priceOf: prices({ 10: 0.5, 20: 6, 30: 4 }) });
  assert.equal(close.assignments.length, 0);
});

test('template di set verificati (RA05 7 candidati: V.5 = Starlight), non verificati ignorati', () => {
  const templates = [
    { setPrefix: 'RA05', variantNumber: 5, rarityCanonical: 'STARLIGHT_RARE', verified: true, candidateCount: 7 },
    { setPrefix: 'RA05', variantNumber: 1, rarityCanonical: 'SUPER_RARE', verified: false, candidateCount: 7 },
  ];
  const canonicalOf = label => String(label).toUpperCase().replace(/[^A-Z]+/g, '_');
  const ids = ['7', '3', '1', '5', '2', '6', '4'];
  const out = resolveBySetTemplates({ targets: [target('s', 'RA05-IT010', 'Starlight Rare', '1', ids), target('x', 'RA05-IT010', 'Super Rare', '1', ids)], templates, canonicalOf });
  assert.equal(out.length, 1);
  assert.equal(out[0].productId, '5');
});

test('guidePrice e familyKey', () => {
  assert.equal(guidePrice({ trend: 0, avg7: 3 }), 3);
  assert.equal(guidePrice(null), null);
  assert.equal(familyKey('1', 'BETB-IT013'), familyKey('1', 'BETB-EN013'));
  assert.notEqual(familyKey('1', 'BETB-IT013'), familyKey('1', 'BETB-IT014'));
});

test('market-sync: chiamata solo nei giri completi, prima dei prezzi, mai sopra varianti live', () => {
  const edge = readFileSync(new URL('../supabase/functions/market-sync/index.ts', import.meta.url), 'utf8');
  assert.match(edge, /from '\.\.\/_shared\/variant-price-order\.js'/);
  const call = edge.indexOf('inferredVariants=await inferMissingExactVariants(provider,resolvedTargets)');
  const pricing = edge.indexOf('const exact=await applyExactVariantPricing(resolvedTargets)');
  assert.ok(call > 0 && pricing > call, 'deve girare prima di applyExactVariantPricing');
  assert.match(edge, /!selectedIds\.size&&!priorityOnly&&!newPrintingsOnly&&!pendingResolverLimit/);
  assert.match(edge, /const missing=aggregate\.filter\(\(target:any\)=>!isLiveExactVariantEligible\(/);
  assert.match(edge, /catch\(error:any\)\{console\.error\('\[market-sync\] varianti automatiche fallite, uso il minimo'/);
});
