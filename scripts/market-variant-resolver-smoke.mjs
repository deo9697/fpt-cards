// Copre resolveYgoMarketVariant() (market/providers.js): precedenza
// verified manual > verified registry > resolved registry > exact match >
// legacy fallback, e soprattutto il caso Rarity Collection (sezione 9 del
// task Market Variant Registry) — stesso set_code/identity carta, due rarity
// diverse, MAI lo stesso prodotto Cardmarket/prezzo.
import assert from 'node:assert/strict';
import { resolveYgoMarketVariant, canonicalYgoRarity, normalizeYgoRarityKey, shouldPersistMarketVariantShadow, summarizeMarketVariantDecisions, MARKET_VARIANT_STATUS, MARKET_VARIANT_SOURCE } from '../market/providers.js';

// 1) Verified manual mapping vince sempre, anche con candidati freschi diversi.
{
  const result = resolveYgoMarketVariant({
    existingVariant: { verified: true, cardmarket_product_id: 'P-MANUAL', mapping_source: 'manual' },
    cardmarketCandidates: [{ productId: 'P-OTHER', expansionId: 'E1' }],
    rarityCanonical: 'SUPER_RARE'
  });
  assert.equal(result.mappingStatus, MARKET_VARIANT_STATUS.VERIFIED);
  assert.equal(result.mappingSource, MARKET_VARIANT_SOURCE.MANUAL);
  assert.equal(result.cardmarketProductId, 'P-MANUAL');
  assert.equal(result.verified, true);
}

// 2) Resolved registry (non verificato) resta stabile tra sync successivi:
//    non viene ricalcolato/sovrascritto solo perché il feed è cambiato,
//    a meno di forceRefresh esplicito.
{
  const existingVariant = { mapping_status: 'resolved', cardmarket_product_id: 'P-REGISTRY', mapping_confidence: 0.8 };
  const stable = resolveYgoMarketVariant({ existingVariant, cardmarketCandidates: [{ productId: 'P-NEW', expansionId: 'E1' }], rarityCanonical: 'SUPER_RARE' });
  assert.equal(stable.mappingStatus, MARKET_VARIANT_STATUS.RESOLVED);
  assert.equal(stable.mappingSource, MARKET_VARIANT_SOURCE.REGISTRY);
  assert.equal(stable.cardmarketProductId, 'P-REGISTRY');
  assert.equal(stable.verified, false);
  const forced = resolveYgoMarketVariant({ existingVariant, cardmarketCandidates: [{ productId: 'P-NEW', expansionId: 'E1' }], rarityCanonical: 'SUPER_RARE', forceRefresh: true });
  assert.equal(forced.cardmarketProductId, 'P-NEW');
  assert.equal(forced.mappingSource, MARKET_VARIANT_SOURCE.RESOLVER);
}

// 3) Zero candidati (e nessun legacy) -> unresolved, mai un prezzo arbitrario.
{
  const result = resolveYgoMarketVariant({ cardmarketCandidates: [], rarityCanonical: 'SUPER_RARE' });
  assert.equal(result.mappingStatus, MARKET_VARIANT_STATUS.UNRESOLVED);
  assert.equal(result.cardmarketProductId, null);
  assert.equal(result.verified, false);
}

// 4) Un solo candidato E la rarity canonica combacia col candidato -> resolved, confidenza massima.
{
  const result = resolveYgoMarketVariant({
    cardmarketCandidates: [{ productId: 'P1', expansionId: 'E1', rarityCanonical: 'SUPER_RARE' }],
    rarityCanonical: 'SUPER_RARE'
  });
  assert.equal(result.mappingStatus, MARKET_VARIANT_STATUS.RESOLVED);
  assert.equal(result.mappingSource, MARKET_VARIANT_SOURCE.RESOLVER);
  assert.equal(result.cardmarketProductId, 'P1');
  assert.equal(result.mappingConfidence, 1);
}

// 5) Un solo candidato ma NESSUNA rarity nel feed (il caso reale del bulk
//    Cardmarket, vedi commento in resolveCardmarketPrinting): resolved ma
//    a confidenza ridotta, mai pari a un match rarity-confermato.
{
  const result = resolveYgoMarketVariant({
    cardmarketCandidates: [{ productId: 'P1', expansionId: 'E1' }],
    rarityCanonical: 'SUPER_RARE'
  });
  assert.equal(result.mappingStatus, MARKET_VARIANT_STATUS.RESOLVED);
  assert.ok(result.mappingConfidence < 1 && result.mappingConfidence > 0);
}

// 6) >1 candidati equivalenti, stessa espansione, nessuna rarity nel feed —
//    ESATTAMENTE il caso Rarity Collection prima della verifica di un
//    curatore: ambiguous, MAI il primo risultato, MAI un prezzo scelto a caso.
{
  const candidates = [{ productId: 'P1', expansionId: 'E1' }, { productId: 'P2', expansionId: 'E1' }, { productId: 'P3', expansionId: 'E1' }];
  const result = resolveYgoMarketVariant({ cardmarketCandidates: candidates, rarityCanonical: 'SUPER_RARE' });
  assert.equal(result.mappingStatus, MARKET_VARIANT_STATUS.AMBIGUOUS);
  assert.equal(result.cardmarketProductId, null);
  assert.deepEqual(result.candidateProductIds.sort(), ['P1', 'P2', 'P3']);
}

// 6b) >1 candidati ma su espansioni DIVERSE tra loro -> conflict (il feed
//     non concorda nemmeno su dove sia il prodotto), distinto da ambiguous.
{
  const candidates = [{ productId: 'P1', expansionId: 'E1' }, { productId: 'P2', expansionId: 'E2' }];
  const result = resolveYgoMarketVariant({ cardmarketCandidates: candidates, rarityCanonical: 'SUPER_RARE' });
  assert.equal(result.mappingStatus, MARKET_VARIANT_STATUS.CONFLICT);
}

// 7) Legacy fallback (mapping market_provider_printings preesistente) non
//    diventa mai verified, e un aggregato legacy multi-prodotto resta ambiguous.
{
  const single = resolveYgoMarketVariant({ cardmarketCandidates: [], legacyMapping: { cardmarketProductId: 'P-LEGACY', candidateProductIds: ['P-LEGACY'] } });
  assert.equal(single.mappingStatus, MARKET_VARIANT_STATUS.RESOLVED);
  assert.equal(single.mappingSource, MARKET_VARIANT_SOURCE.LEGACY);
  assert.equal(single.verified, false);
  assert.ok(single.mappingConfidence < 1);
  const aggregate = resolveYgoMarketVariant({ cardmarketCandidates: [], legacyMapping: { cardmarketProductId: 'P-LEGACY', candidateProductIds: ['P-LEGACY', 'P-OTHER'] } });
  assert.equal(aggregate.mappingStatus, MARKET_VARIANT_STATUS.AMBIGUOUS);
  assert.equal(aggregate.verified, false);
}

// 7b) Un esito fresco ambiguous/conflict NON viene mai nascosto/sostituito
//     dal legacy fallback (il fallback si applica SOLO a zero candidati
//     freschi) — altrimenti si tornerebbe a "scegliere il primo risultato".
{
  const result = resolveYgoMarketVariant({
    cardmarketCandidates: [{ productId: 'P1', expansionId: 'E1' }, { productId: 'P2', expansionId: 'E1' }],
    legacyMapping: { cardmarketProductId: 'P-LEGACY-PICK', candidateProductIds: ['P-LEGACY-PICK'] }
  });
  assert.equal(result.mappingStatus, MARKET_VARIANT_STATUS.AMBIGUOUS);
  assert.notEqual(result.cardmarketProductId, 'P-LEGACY-PICK');
}

// 8) IL CASO RICHIESTO (sezione 9): stesso set_code/identity carta, stesso
//    pool di candidati ambiguo dal feed Cardmarket (il feed bulk non porta
//    la rarity, quindi vede lo stesso identico gruppo di prodotti per
//    entrambe le rarity di RA01-ENxxx), ma due mapping verificati DISTINTI
//    per le due printing (due printing_id diversi, una riga ygo_market_variants
//    ciascuna) -> due market variant risolti a DUE prodotti Cardmarket
//    distinti, mai lo stesso, mai contaminati a vicenda.
{
  const sharedAmbiguousCandidates = [{ productId: 'RC-SUPER', expansionId: 'RA01' }, { productId: 'RC-QCSR', expansionId: 'RA01' }];
  const superRareVariant = resolveYgoMarketVariant({
    existingVariant: { verified: true, cardmarket_product_id: 'RC-SUPER', mapping_source: 'manual' },
    cardmarketCandidates: sharedAmbiguousCandidates,
    rarityCanonical: canonicalYgoRarity('Super Rare', new Map([[normalizeYgoRarityKey('Super Rare'), 'SUPER_RARE']]))
  });
  const qcsrVariant = resolveYgoMarketVariant({
    existingVariant: { verified: true, cardmarket_product_id: 'RC-QCSR', mapping_source: 'manual' },
    cardmarketCandidates: sharedAmbiguousCandidates,
    rarityCanonical: canonicalYgoRarity('Quarter Century Secret Rare', new Map([[normalizeYgoRarityKey('Quarter Century Secret Rare'), 'QUARTER_CENTURY_SECRET_RARE']]))
  });
  assert.equal(superRareVariant.mappingStatus, MARKET_VARIANT_STATUS.VERIFIED);
  assert.equal(qcsrVariant.mappingStatus, MARKET_VARIANT_STATUS.VERIFIED);
  assert.equal(superRareVariant.cardmarketProductId, 'RC-SUPER');
  assert.equal(qcsrVariant.cardmarketProductId, 'RC-QCSR');
  assert.notEqual(superRareVariant.cardmarketProductId, qcsrVariant.cardmarketProductId, 'Super Rare e Quarter Century Secret Rare non devono MAI condividere lo stesso prodotto/prezzo');

  // Pre-verifica (nessun curatore ha ancora scelto): stesso pool ambiguo,
  // nessuna delle due deve auto-risolversi a un prodotto arbitrario/comune.
  const superRareBeforeVerify = resolveYgoMarketVariant({ cardmarketCandidates: sharedAmbiguousCandidates, rarityCanonical: 'SUPER_RARE' });
  const qcsrBeforeVerify = resolveYgoMarketVariant({ cardmarketCandidates: sharedAmbiguousCandidates, rarityCanonical: 'QUARTER_CENTURY_SECRET_RARE' });
  assert.equal(superRareBeforeVerify.mappingStatus, MARKET_VARIANT_STATUS.AMBIGUOUS);
  assert.equal(qcsrBeforeVerify.mappingStatus, MARKET_VARIANT_STATUS.AMBIGUOUS);
  assert.equal(superRareBeforeVerify.cardmarketProductId, null);
  assert.equal(qcsrBeforeVerify.cardmarketProductId, null);
}

// 9) canonicalYgoRarity()/normalizeYgoRarityKey() — mirror JS della
//    normalizzazione SQL: case e apostrofo non contano, parole diverse sì.
{
  const aliasMap = new Map([
    [normalizeYgoRarityKey('Collector\'s Rare'), 'COLLECTORS_RARE'],
    [normalizeYgoRarityKey('Super Rare'), 'SUPER_RARE']
  ]);
  assert.equal(canonicalYgoRarity('Collectors Rare', aliasMap), 'COLLECTORS_RARE');
  assert.equal(canonicalYgoRarity('COLLECTOR’S RARE', aliasMap), 'COLLECTORS_RARE');
  assert.equal(canonicalYgoRarity('super rare', aliasMap), 'SUPER_RARE');
  assert.equal(canonicalYgoRarity('Ultra Rare', aliasMap), null, 'una rarity non in tabella deve restare NULL, mai un guess');
}

// 10) shouldPersistMarketVariantShadow(): mai riscrivere una riga verified,
//     sempre persistere tutto il resto (idempotenza + "non sovrascrivere
//     verified" del wiring shadow, sezione 6/11 del task shadow mode).
{
  assert.equal(shouldPersistMarketVariantShadow({ verified: true, cardmarket_product_id: 'P1' }), false);
  assert.equal(shouldPersistMarketVariantShadow({ verified: false, cardmarket_product_id: 'P1', mapping_status: 'resolved' }), true);
  assert.equal(shouldPersistMarketVariantShadow(null), true);
  assert.equal(shouldPersistMarketVariantShadow({ verified: true, cardmarket_product_id: null }), true, 'verified senza un product id non è un mapping reale da proteggere');
}

// 11) summarizeMarketVariantDecisions(): telemetria di run, solo summary.
{
  const summary = summarizeMarketVariantDecisions([
    { mappingStatus: MARKET_VARIANT_STATUS.VERIFIED }, { mappingStatus: MARKET_VARIANT_STATUS.RESOLVED },
    { mappingStatus: MARKET_VARIANT_STATUS.AMBIGUOUS }, { mappingStatus: MARKET_VARIANT_STATUS.AMBIGUOUS },
    { mappingStatus: MARKET_VARIANT_STATUS.CONFLICT }, { mappingStatus: MARKET_VARIANT_STATUS.UNRESOLVED }
  ]);
  assert.deepEqual(summary, { processed: 6, verified: 1, resolved: 1, ambiguous: 2, conflict: 1, unresolved: 1, errors: 0 });
}

// 12) Idempotenza su due run consecutivi: il secondo run, alimentato con la
//     riga persistita dal primo (non verified), deve restare stabile — non
//     deve "sdoppiarsi" né oscillare tra stati diversi in assenza di nuovi dati.
{
  const candidates = [{ productId: 'P1', expansionId: 'E1' }, { productId: 'P2', expansionId: 'E1' }];
  const run1 = resolveYgoMarketVariant({ cardmarketCandidates: candidates, rarityCanonical: 'SUPER_RARE' });
  assert.equal(run1.mappingStatus, MARKET_VARIANT_STATUS.AMBIGUOUS);
  // Il run 2 riceve come existingVariant esattamente quello che il run 1
  // avrebbe scritto (mapping_status:'ambiguous', nessun cardmarket_product_id).
  // 'ambiguous' non è tra gli stati "stabili" preservati (solo 'resolved' lo
  // è, per costruzione — vedi resolveYgoMarketVariant): il run 2 ricalcola,
  // ma con lo STESSO input deve produrre lo STESSO risultato, non un altro.
  const run2 = resolveYgoMarketVariant({
    existingVariant: { mapping_status: run1.mappingStatus, cardmarket_product_id: run1.cardmarketProductId, verified: false },
    cardmarketCandidates: candidates, rarityCanonical: 'SUPER_RARE'
  });
  assert.deepEqual(run2, run1, 'stesso input, stesso output: nessuna oscillazione tra run consecutivi');
}

// 13) Rarity Collection realistica: 7 prodotti Cardmarket (RA01..RA05-style),
//     nessuna rarity nel feed — ambiguous, candidate_product_ids con tutti e
//     7, MAI scelto per indice/posizione/prezzo (qui i candidati non hanno
//     nemmeno un prezzo associato: la scelta deve essere strutturalmente
//     impossibile, non solo "evitata per policy").
{
  const sevenCandidates = ['RA-SUP','RA-ULT','RA-SEC','RA-PSE','RA-COL','RA-ULM','RA-QCS'].map(productId => ({ productId, expansionId: 'RARITY-COLLECTION-EXP' }));
  const superRare = resolveYgoMarketVariant({ cardmarketCandidates: sevenCandidates, rarityCanonical: 'SUPER_RARE' });
  const quarterCentury = resolveYgoMarketVariant({ cardmarketCandidates: sevenCandidates, rarityCanonical: 'QUARTER_CENTURY_SECRET_RARE' });
  for (const result of [superRare, quarterCentury]) {
    assert.equal(result.mappingStatus, MARKET_VARIANT_STATUS.AMBIGUOUS);
    assert.equal(result.cardmarketProductId, null);
    assert.deepEqual(result.candidateProductIds.sort(), ['RA-COL','RA-PSE','RA-QCS','RA-SEC','RA-SUP','RA-ULM','RA-ULT']);
  }
}

console.log('PASS market variant resolver: precedenza verified>registry>resolver>legacy, 0/>1 candidati, Rarity Collection (Super Rare vs Quarter Century Secret Rare) mai contaminati, idempotenza su run consecutivi, mai una scelta per indice/prezzo su 7 candidati');
