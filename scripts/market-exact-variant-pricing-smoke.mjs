// Copre il cutover live del prezzo per variante esatta (market/providers.js):
// un mapping Cardmarket aggregate (V.1..V.n, prezzo = minimo tra rarità)
// viene ristretto al SOLO product_id della variante risolta, così una
// Starlight non prende più il prezzo della Super. Verifica anche che la
// copia in supabase/functions/market-sync/index.ts resti allineata.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isLiveExactVariantEligible, narrowTargetToExactVariant } from '../market/providers.js';

const aggregate = {
  printing_id: 'p1', mapping_id: 'm1', resolution_status: 'resolved', provider_product_id: 'P1',
  provider_metadata: { resolverStatus: 'provider_aggregate', candidateProductIds: ['P1', 'P2', 'P3'], priceScope: { product: 'minimum_across_candidates', rarity: 'aggregate' } }
};

// --- isLiveExactVariantEligible -------------------------------------------
assert.equal(isLiveExactVariantEligible({ cardmarket_product_id: 'P3', verified: true, mapping_status: 'verified' }), true);
assert.equal(isLiveExactVariantEligible({ cardmarket_product_id: 'P3', verified: false, mapping_status: 'resolved', mapping_confidence: 1 }), true);
assert.equal(isLiveExactVariantEligible({ cardmarket_product_id: 'P3', verified: false, mapping_status: 'resolved', mapping_confidence: '1.00' }), true);
// resolved senza segnale di rarità (0.6) non basta per il prezzo live
assert.equal(isLiveExactVariantEligible({ cardmarket_product_id: 'P3', verified: false, mapping_status: 'resolved', mapping_confidence: 0.6 }), false);
assert.equal(isLiveExactVariantEligible({ cardmarket_product_id: 'P3', verified: false, mapping_status: 'ambiguous', mapping_confidence: 0 }), false);
assert.equal(isLiveExactVariantEligible({ cardmarket_product_id: null, verified: true }), false);
assert.equal(isLiveExactVariantEligible(null), false);
console.log('PASS isLiveExactVariantEligible: verified o resolved@1, mai 0.6/ambiguous/null');

// --- narrowTargetToExactVariant -------------------------------------------
{
  const narrowed = narrowTargetToExactVariant(aggregate, { cardmarket_product_id: 'P3', verified: false, mapping_status: 'resolved', mapping_confidence: 1, mapping_source: 'verified_set_template' });
  assert.notEqual(narrowed, aggregate);
  assert.equal(narrowed.provider_product_id, 'P3');
  assert.deepEqual(narrowed.provider_metadata.candidateProductIds, ['P3']);
  assert.equal(narrowed.provider_metadata.priceScope.product, 'exact_variant');
  assert.equal(narrowed.provider_metadata.exactVariant.mappingSource, 'verified_set_template');
  assert.equal(narrowed.mapping_id, 'm1', 'il mapping live resta lo stesso');
  assert.deepEqual(aggregate.provider_metadata.candidateProductIds, ['P1', 'P2', 'P3'], 'il target originale non viene mutato');
}
// product_id fuori dai candidati: invariato (resta il minimo)
assert.equal(narrowTargetToExactVariant(aggregate, { cardmarket_product_id: 'P9', verified: true }), aggregate);
// variante non eleggibile: invariato
assert.equal(narrowTargetToExactVariant(aggregate, { cardmarket_product_id: 'P3', mapping_status: 'resolved', mapping_confidence: 0.6 }), aggregate);
// nessuna variante: invariato
assert.equal(narrowTargetToExactVariant(aggregate, null), aggregate);
// mapping già a prodotto singolo: invariato
{
  const single = { ...aggregate, provider_metadata: { candidateProductIds: [] }, provider_product_id: 'P1' };
  assert.equal(narrowTargetToExactVariant(single, { cardmarket_product_id: 'P1', verified: true }), single);
}
console.log('PASS narrowTargetToExactVariant: restringe solo aggregate con variante certa tra i candidati');

// --- copia nell'Edge Function ---------------------------------------------
{
  const edge = readFileSync(new URL('../supabase/functions/market-sync/index.ts', import.meta.url), 'utf8');
  assert.match(edge, /function isLiveExactVariantEligible\(/);
  assert.match(edge, /function narrowTargetToExactVariant\(/);
  assert.match(edge, /mapping_status==='resolved'&&Number\(variant\.mapping_confidence\)>=1/);
  assert.match(edge, /applyExactVariantPricing\(resolvedTargets\)/);
  assert.match(edge, /MARKET_EXACT_VARIANT_PRICING/);
  const migration = readFileSync(new URL('../supabase/migrations/20261012120000_market_exact_variant_pricing_anomaly_scope.sql', import.meta.url), 'utf8');
  assert.match(migration, /'exact_variant' in/);
}
console.log('PASS market-sync: copia allineata, cutover cablato prima degli snapshot');
