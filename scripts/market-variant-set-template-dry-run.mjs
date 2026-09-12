// Dry-run del set template resolver (sezione 8 del task): prende righe
// mapping_status='ambiguous' già esportate da
// list_ygo_market_variant_ambiguous_for_dry_run (RPC, chi ha accesso al DB
// reale la esegue e salva il risultato su file) e mostra quali
// diventerebbero resolved_by_set_template — SENZA scrivere nulla nel DB.
// Nessuna chiamata Cardmarket: candidate_product_ids sono già locali.
//
// Uso:
//   node scripts/market-variant-set-template-dry-run.mjs ambiguous-rows.json
//
// ambiguous-rows.json: l'array (o {rows:[...]}) restituito da
//   select list_ygo_market_variant_ambiguous_for_dry_run('<token>');
// Per applicare davvero le risoluzioni deterministiche trovate qui, passa le
// coppie {printing_id, cardmarket_product_id} di new_status='resolved_by_
// set_template' a apply_ygo_verified_set_template_resolutions() — passo
// separato e deliberato, mai automatico da questo script.
import fs from 'node:fs';
import { resolveYgoMarketVariantBySetTemplate } from '../market/providers.js';
import { SET_TEMPLATE_SEED } from '../market/set-template-seed.js';

const [, , inputPath] = process.argv;
if (!inputPath) {
  console.error('Uso: node scripts/market-variant-set-template-dry-run.mjs ambiguous-rows.json');
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const rows = Array.isArray(raw) ? raw : (raw.rows || []);
if (!rows.length) { console.error('Nessuna riga trovata nel file — è l\'export giusto di list_ygo_market_variant_ambiguous_for_dry_run?'); process.exit(1); }

const report = rows.map(row => {
  const candidateIds = Array.isArray(row.candidate_product_ids) ? row.candidate_product_ids : [];
  const match = resolveYgoMarketVariantBySetTemplate({
    setCode: row.set_code,
    rarityCanonical: row.rarity_canonical,
    candidateProductIds: candidateIds,
    setTemplates: SET_TEMPLATE_SEED
  });
  return {
    printing_id: row.printing_id,
    set_code: row.set_code,
    rarity: row.rarity,
    current_status: row.mapping_status,
    candidate_count: candidateIds.length,
    template_variant: match ? match.variantNumber : null,
    selected_product_id: match ? match.productId : null,
    new_status: match ? 'resolved_by_set_template' : row.mapping_status
  };
});

const resolvable = report.filter(row => row.new_status === 'resolved_by_set_template');
console.log(JSON.stringify({
  totalEvaluated: report.length,
  resolvableBySetTemplate: resolvable.length,
  stillAmbiguous: report.length - resolvable.length,
  rows: report
}, null, 2));
