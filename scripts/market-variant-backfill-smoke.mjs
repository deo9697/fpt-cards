// Copre le funzioni pure del backfill mirato RA01/RA02 in uso:
// classifyYgoMarketVariantBackfillAction() (preview, prima di qualunque
// write) e summarizeYgoMarketVariantBackfillRun() (report dopo il canary,
// riusato senza una nuova RPC di lettura). Nessuna riga di Postgres/Deno
// coinvolta — stesso stile delle altre smoke di market/providers.js.
import assert from 'node:assert/strict';
import { classifyYgoMarketVariantBackfillAction, summarizeYgoMarketVariantBackfillRun, resolveYgoMarketVariantBySetTemplate } from '../market/providers.js';

// Template RA01 esattamente come seedato nella migration 20260912200000 —
// solo le prime due righe servono per Super/Ultra Rare (V.1/V.2).
const RA01_TEMPLATE = [
  { setPrefix: 'RA01', variantNumber: 1, rarityCanonical: 'SUPER_RARE', verified: true },
  { setPrefix: 'RA01', variantNumber: 2, rarityCanonical: 'ULTRA_RARE', verified: true }
];

// 12/13/14) already resolved / manual / verified -> SEMPRE skip, mai un
// ricalcolo o una sovrascrittura, indipendentemente da candidati o set.
{
  assert.equal(classifyYgoMarketVariantBackfillAction({ mappingStatus: 'resolved', setCode: 'RA01-EN061', rarityCanonical: 'SUPER_RARE', candidateProductIds: ['X'], setTemplates: RA01_TEMPLATE }), 'skip_already_resolved');
  assert.equal(classifyYgoMarketVariantBackfillAction({ mappingSource: 'manual', mappingStatus: 'ambiguous', setCode: 'RA01-EN061', rarityCanonical: 'SUPER_RARE', candidateProductIds: ['X', 'Y'], setTemplates: RA01_TEMPLATE }), 'skip_already_resolved');
  assert.equal(classifyYgoMarketVariantBackfillAction({ verified: true, mappingStatus: 'ambiguous', setCode: 'RA01-EN061', rarityCanonical: 'SUPER_RARE', candidateProductIds: ['X', 'Y'], setTemplates: RA01_TEMPLATE }), 'skip_already_resolved');
}

// 17/18) template resolve Super -> V.1, Ultra -> V.2: stessa
// resolveYgoMarketVariantBySetTemplate() del resolver, per posizione, mai
// per valore dell'id (due id completamente diversi, stesso risultato di
// posizione).
{
  const superAction = classifyYgoMarketVariantBackfillAction({ mappingStatus: 'ambiguous', setCode: 'RA01-EN061', rarityCanonical: 'SUPER_RARE', candidateProductIds: ['741693', '741694'], setTemplates: RA01_TEMPLATE });
  assert.equal(superAction, 'resolve_set_template');
  const superMatch = resolveYgoMarketVariantBySetTemplate({ setCode: 'RA01-EN061', rarityCanonical: 'SUPER_RARE', candidateProductIds: ['741693', '741694'], setTemplates: RA01_TEMPLATE });
  assert.equal(superMatch.productId, '741693'); assert.equal(superMatch.variantNumber, 1);

  const ultraAction = classifyYgoMarketVariantBackfillAction({ mappingStatus: 'unresolved', setCode: 'RA01-EN061', rarityCanonical: 'ULTRA_RARE', candidateProductIds: ['999111', '999222'], setTemplates: RA01_TEMPLATE });
  assert.equal(ultraAction, 'resolve_set_template');
  const ultraMatch = resolveYgoMarketVariantBySetTemplate({ setCode: 'RA01-EN061', rarityCanonical: 'ULTRA_RARE', candidateProductIds: ['999111', '999222'], setTemplates: RA01_TEMPLATE });
  assert.equal(ultraMatch.productId, '999222'); assert.equal(ultraMatch.variantNumber, 2);
}

// 19) candidate array più corto della posizione richiesta -> mai un resolve,
//     resta 'remain_ambiguous' (candidati già noti, nessun match deterministico).
{
  const shortArray = classifyYgoMarketVariantBackfillAction({ mappingStatus: 'ambiguous', setCode: 'RA01-EN061', rarityCanonical: 'ULTRA_RARE', candidateProductIds: ['741693'], setTemplates: RA01_TEMPLATE });
  assert.equal(shortArray, 'remain_ambiguous', 'V.2 richiesto ma solo 1 candidato noto: mai un resolve');
}

// 20) rarity sconosciuta/non nel template -> nessun match, resta ambigua
//     (mai un guess sulla prima posizione disponibile).
{
  const unknownRarity = classifyYgoMarketVariantBackfillAction({ mappingStatus: 'ambiguous', setCode: 'RA01-EN061', rarityCanonical: 'GHOST_RARE', candidateProductIds: ['741693', '741694'], setTemplates: RA01_TEMPLATE });
  assert.equal(unknownRarity, 'remain_ambiguous');
}

// Nessuna riga di registry ancora (mai passata dal resolver): serve il
// canary per scoprire i candidati, non c'è nulla da classificare come
// template-resolvable finché non esistono candidate_product_ids.
{
  const noCandidatesYet = classifyYgoMarketVariantBackfillAction({ mappingStatus: 'unresolved', registryExists: false, setCode: 'RA01-EN061', rarityCanonical: 'SUPER_RARE', candidateProductIds: [], setTemplates: RA01_TEMPLATE });
  assert.equal(noCandidatesYet, 'run_resolver');
}

// Set non whitelisted (nessuna riga verified in setTemplates per questo
// prefisso, es. RA03/RA05): anche con candidati e rarity note, mai un
// resolve — extractYgoSetPrefix + il filtro verified dentro
// resolveYgoMarketVariantBySetTemplate fanno già il lavoro, qui si verifica
// che il backfill NON aggiri quella garanzia.
{
  const nonWhitelistedSet = classifyYgoMarketVariantBackfillAction({ mappingStatus: 'ambiguous', setCode: 'RA03-EN010', rarityCanonical: 'SUPER_RARE', candidateProductIds: ['1', '2'], setTemplates: RA01_TEMPLATE });
  assert.equal(nonWhitelistedSet, 'remain_ambiguous', 'RA03 non ha righe verified in questo setTemplates: mai un resolve');
}

// summarizeYgoMarketVariantBackfillRun(): riusa i resultRows del canary
// esistente (stessa forma: resolution_reason/shadow_status/...), nessuna
// nuova RPC di lettura. Copre le 8 chiavi richieste dal report finale.
{
  const rows = [
    { printing_id: 'p1', resolution_reason: 'verified_mapping_preserved', shadow_status: 'verified' },
    { printing_id: 'p2', resolution_reason: 'resolved_registry_preserved', shadow_status: 'resolved' },
    { printing_id: 'p3', resolution_reason: 'verified_set_variant_template', shadow_status: 'resolved' },
    { printing_id: 'p4', resolution_reason: 'exact_rarity_single_candidate', shadow_status: 'resolved' },
    { printing_id: 'p5', resolution_reason: 'multiple_candidates_no_rarity_signal', shadow_status: 'ambiguous' },
    { printing_id: 'p6', resolution_reason: 'multiple_provider_expansions', shadow_status: 'conflict' },
    { printing_id: 'p7', resolution_reason: 'no_cardmarket_candidates', shadow_status: 'unresolved' }
  ];
  const report = summarizeYgoMarketVariantBackfillRun(rows);
  assert.deepEqual(
    { processed: report.processed, already_resolved: report.already_resolved, resolved_set_template: report.resolved_set_template, resolved_other: report.resolved_other, ambiguous: report.ambiguous, conflict: report.conflict, unresolved: report.unresolved, errors: report.errors },
    { processed: 7, already_resolved: 2, resolved_set_template: 1, resolved_other: 1, ambiguous: 1, conflict: 1, unresolved: 1, errors: 0 }
  );
  // "changed" NON include le righe already_resolved (nulla è cambiato per
  // quelle), include tutte le altre 5.
  assert.equal(report.changed.length, 5);
  assert.equal(report.changed.some(row => row.printing_id === 'p1'), false);
  assert.equal(report.changed.some(row => row.printing_id === 'p2'), false);
}

// 24) Idempotenza: rilanciare il backfill su righe GIÀ risolte da un run
//     precedente (stesso resolution_reason 'resolved_registry_preserved' o
//     'verified_mapping_preserved' prodotto da resolveYgoMarketVariant per
//     un existingVariant già resolved/verified) finisce sempre in
//     already_resolved, mai un downgrade/duplicato/oscillazione.
{
  const secondRunRows = [
    { printing_id: 'p1', resolution_reason: 'verified_mapping_preserved', shadow_status: 'verified' },
    { printing_id: 'p3', resolution_reason: 'resolved_registry_preserved', shadow_status: 'resolved' } // p3 era resolved_set_template al primo giro
  ];
  const secondReport = summarizeYgoMarketVariantBackfillRun(secondRunRows);
  assert.equal(secondReport.already_resolved, 2);
  assert.equal(secondReport.resolved_set_template, 0);
  assert.equal(secondReport.ambiguous, 0);
  assert.equal(secondReport.conflict, 0);
}

// errors: la run del batch fallisce interamente (nessun resultRow) -> il
// chiamante (runMarketVariantBackfill in app.js) somma le printing di quel
// batch a errors DOPO aver chiamato questa funzione sulle righe riuscite;
// qui si verifica solo che un report vuoto resti coerente (mai un NaN/undefined).
{
  const emptyReport = summarizeYgoMarketVariantBackfillRun([]);
  assert.deepEqual(emptyReport, { processed: 0, already_resolved: 0, resolved_set_template: 0, resolved_other: 0, ambiguous: 0, conflict: 0, unresolved: 0, errors: 0, changed: [] });
}

console.log('PASS market variant backfill (funzioni pure): classify (already-resolved/manual/verified sempre skip, template Super->V1/Ultra->V2 per posizione, candidate array corto e rarity sconosciuta mai un resolve, set non whitelisted mai aggirato), summarize (8 chiavi del report, changed esclude gli already_resolved, idempotenza su rerun)');
