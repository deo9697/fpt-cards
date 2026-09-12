// Copre le funzioni pure della fase finale dello shadow pricing
// (market/providers.js): eleggibilità exact price, estrazione del prezzo di
// UN SOLO product_id dal Price Guide (mai Math.min tra candidati), e
// classificazione del confronto legacy vs exact.
import assert from 'node:assert/strict';
import { exactPriceForProduct, isExactPriceEligible, classifyPriceComparison } from '../market/providers.js';

// --- isExactPriceEligible -----------------------------------------------
// 1) verified + product_id -> eligible
assert.equal(isExactPriceEligible({ cardmarket_product_id: 'P1', verified: true, mapping_status: 'verified' }), true);
// 2) resolved + product_id -> eligible
assert.equal(isExactPriceEligible({ cardmarket_product_id: 'P1', verified: false, mapping_status: 'resolved' }), true);
// 3) ambiguous -> not eligible
assert.equal(isExactPriceEligible({ cardmarket_product_id: 'P1', verified: false, mapping_status: 'ambiguous' }), false);
// 4) conflict -> not eligible
assert.equal(isExactPriceEligible({ cardmarket_product_id: 'P1', verified: false, mapping_status: 'conflict' }), false);
// 5) unresolved -> not eligible
assert.equal(isExactPriceEligible({ cardmarket_product_id: 'P1', verified: false, mapping_status: 'unresolved' }), false);
// 6) product_id null -> not eligible anche se verified (non dovrebbe succedere ma difensivo)
assert.equal(isExactPriceEligible({ cardmarket_product_id: null, verified: true, mapping_status: 'verified' }), false);
assert.equal(isExactPriceEligible(null), false);
console.log('PASS isExactPriceEligible: verified/resolved eligible, ambiguous/conflict/unresolved/product_id-null non eligible');

// --- exactPriceForProduct -------------------------------------------------
// 7) usa UN SOLO product_id: due prodotti nella mappa, ne leggo solo uno.
{
  const prices = new Map([
    ['P1', { trend: '2.50', low: '1.00' }],
    ['P2', { trend: '0.10', low: '0.05' }]
  ]);
  const result = exactPriceForProduct(prices, 'P1');
  assert.equal(result.value, 2.5);
  assert.equal(result.type, 'trend');
}
// 8) NON fa MIN tra candidate_product_ids: anche passando una mappa che
//    contiene un prezzo più basso per un altro id, il risultato per P1 resta
//    quello di P1, mai il minimo tra P1 e P2.
{
  const prices = new Map([
    ['P1', { trend: '9.99' }],
    ['P2', { trend: '0.01' }]
  ]);
  assert.equal(exactPriceForProduct(prices, 'P1').value, 9.99, 'exact price non deve mai diventare il minimo tra prodotti diversi');
}
// Priorità: trend prima di average/avg7 prima di low/lowest.
{
  const prices = new Map([['P3', { avg: '3.00', low: '1.50' }]]);
  assert.equal(exactPriceForProduct(prices, 'P3').type, 'average');
  assert.equal(exactPriceForProduct(prices, 'P3').value, 3);
}
{
  const prices = new Map([['P4', { low: '0.75' }]]);
  const result = exactPriceForProduct(prices, 'P4');
  assert.equal(result.type, 'low');
  assert.equal(result.value, 0.75);
}
// Prodotto non nel Price Guide (delistato, o non ancora fetchato) -> null, mai un errore.
assert.equal(exactPriceForProduct(new Map(), 'P5'), null);
assert.equal(exactPriceForProduct(null, 'P5'), null);
console.log('PASS exactPriceForProduct: un solo product_id, mai un minimo tra candidati, priorità trend>average/avg7>low, null se assente');

// --- classifyPriceComparison ----------------------------------------------
// 9) exact_missing ha precedenza assoluta
assert.deepEqual(classifyPriceComparison(1.5, null), { comparisonStatus: 'exact_missing', absoluteDelta: null, percentageDelta: null });
// legacy_missing quando manca solo il legacy
assert.deepEqual(classifyPriceComparison(null, 2.0), { comparisonStatus: 'legacy_missing', absoluteDelta: null, percentageDelta: null });
// same: differenza < 1 centesimo
{
  const r = classifyPriceComparison(2.50, 2.505);
  assert.equal(r.comparisonStatus, 'same');
}
// close: differenza percentuale < 5%
{
  const r = classifyPriceComparison(10, 10.3);
  assert.equal(r.comparisonStatus, 'close');
  assert.equal(r.absoluteDelta, 0.3);
}
// different: oltre le soglie (il caso reale RA02-EN024 atteso: legacy basso, exact molto più alto)
{
  const r = classifyPriceComparison(0.30, 2.80);
  assert.equal(r.comparisonStatus, 'different');
  assert.equal(r.absoluteDelta, 2.5);
  assert.ok(r.percentageDelta > 800 && r.percentageDelta < 835);
}
console.log('PASS classifyPriceComparison: exact_missing/legacy_missing hanno precedenza, soglie same<€0.01, close<5%, different oltre');

console.log('PASS exact price shadow (funzioni pure): eleggibilità, estrazione single-product, classificazione confronto');
