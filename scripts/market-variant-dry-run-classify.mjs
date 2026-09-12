// Analizza OFFLINE l'output del dry-run già esistente e già sicuro del
// market-sync Edge Function (payload {"dryTargetPrintingIds":[...]}) —
// quella chiamata non scrive MAI in market_provider_printings (vedi
// dryTargetCardmarket() in supabase/functions/market-sync/index.ts, che non
// richiama mai resolveCardmarketTargets/l'unico path di scrittura). Questo
// script prende il JSON di quella risposta (già ottenuto da chi ha accesso
// al progetto Supabase reale) e lo fa passare per resolveYgoMarketVariant()
// per classificarlo secondo il Market Variant Registry — senza persistere
// nulla, senza toccare cron/Market Watch live.
//
// Uso:
//   node scripts/market-variant-dry-run-classify.mjs dry-run-response.json [legacy-mappings.json]
//
// dry-run-response.json: la risposta intera (o solo il suo campo "results")
//   della chiamata POST a market-sync con {"dryTargetPrintingIds":[...]}.
// legacy-mappings.json (opzionale): righe da
//   `select printing_id, provider_product_id, resolution_status,
//    provider_metadata->>'resolverStatus' as resolver_status,
//    provider_metadata->'candidateProductIds' as candidate_product_ids
//    from market_provider_printings where provider='cardmarket'
//    and printing_id in (<gli stessi id del dry run>)`
//   — se assente, il bucket legacy_fallback_only resta 0 (dato non fornito).
import fs from 'node:fs';
import { resolveYgoMarketVariant, canonicalYgoRarity, normalizeYgoRarityKey, MARKET_VARIANT_STATUS, MARKET_VARIANT_SOURCE } from '../market/providers.js';
import { RARITY_ALIAS_SEED } from '../market/rarity-canon-seed.js';

const [, , dryRunPath, legacyPath] = process.argv;
if (!dryRunPath) {
  console.error('Uso: node scripts/market-variant-dry-run-classify.mjs dry-run-response.json [legacy-mappings.json]');
  process.exit(1);
}

const aliasMap = new Map(RARITY_ALIAS_SEED.map(([raw, code]) => [normalizeYgoRarityKey(raw), code]));

const rawDryRun = JSON.parse(fs.readFileSync(dryRunPath, 'utf8'));
const results = Array.isArray(rawDryRun) ? rawDryRun : (rawDryRun.results || []);
if (!results.length) { console.error('Nessun elemento "results" trovato nel file — è la risposta giusta del dry-run?'); process.exit(1); }

const legacyByPrinting = new Map();
if (legacyPath) {
  const legacyRows = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
  for (const row of legacyRows) {
    if (!row.provider_product_id) continue;
    legacyByPrinting.set(String(row.printing_id), {
      cardmarketProductId: row.provider_product_id,
      cardmarketExpansionId: row.provider_expansion_id || null,
      candidateProductIds: Array.isArray(row.candidate_product_ids) ? row.candidate_product_ids : (row.candidate_product_ids ? [row.candidate_product_ids] : [row.provider_product_id])
    });
  }
}

const buckets = { resolved_exact: [], ambiguous: [], conflict: [], unresolved: [], legacy_fallback_only: [] };
const rows = [];

for (const target of results) {
  const rarityCanonical = canonicalYgoRarity(target.rarity, aliasMap);
  const candidates = (target.candidates || []).map(c => ({
    productId: c.providerProductId || null,
    expansionId: c.providerExpansionId || null,
    rarityCanonical: canonicalYgoRarity(c.rarity, aliasMap)
  })).filter(c => c.productId);
  const legacyMapping = legacyByPrinting.get(String(target.printingId)) || null;
  const decision = resolveYgoMarketVariant({ existingVariant: null, cardmarketCandidates: candidates, rarityCanonical, legacyMapping });

  let bucket;
  if (decision.mappingSource === MARKET_VARIANT_SOURCE.LEGACY) bucket = 'legacy_fallback_only';
  else if (decision.mappingStatus === MARKET_VARIANT_STATUS.RESOLVED) bucket = 'resolved_exact';
  else if (decision.mappingStatus === MARKET_VARIANT_STATUS.AMBIGUOUS) bucket = 'ambiguous';
  else if (decision.mappingStatus === MARKET_VARIANT_STATUS.CONFLICT) bucket = 'conflict';
  else bucket = 'unresolved';
  buckets[bucket].push(target.printingId);

  rows.push({
    printingId: target.printingId, cardName: target.cardName, setCode: target.setCode, rarity: target.rarity, rarityCanonical,
    bucket, mappingConfidence: decision.mappingConfidence, cardmarketProductId: decision.cardmarketProductId,
    candidateCount: candidates.length, candidateProductIds: decision.candidateProductIds, reason: decision.reason,
    rawResolverStatus: target.status, rawResolverReason: target.reason
  });
}

console.log(JSON.stringify({
  totalEvaluated: results.length,
  resolved_exact: buckets.resolved_exact.length,
  ambiguous: buckets.ambiguous.length,
  conflict: buckets.conflict.length,
  unresolved: buckets.unresolved.length,
  legacy_fallback_only: buckets.legacy_fallback_only.length,
  rows
}, null, 2));
