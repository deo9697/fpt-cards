// Copre resolveYgoMarketVariantBySetTemplate() (resolver deterministico
// V.n -> rarity per set esplicitamente whitelisted) e la sua integrazione in
// resolveYgoMarketVariant() (priorità: manual verified > verified registry >
// set template > exact resolver logic > ambiguous/conflict/unresolved).
import assert from 'node:assert/strict';
import { resolveYgoMarketVariant, resolveYgoMarketVariantBySetTemplate, MARKET_VARIANT_STATUS, MARKET_VARIANT_SOURCE } from '../market/providers.js';

// Template RA01/RA02 esattamente come seedati nella migration
// 20260912200000 — NON hardcodare i product_id, solo il template astratto.
const RA_TEMPLATE = [
  { setPrefix: 'RA01', variantNumber: 1, rarityCanonical: 'SUPER_RARE', verified: true },
  { setPrefix: 'RA01', variantNumber: 2, rarityCanonical: 'ULTRA_RARE', verified: true },
  { setPrefix: 'RA01', variantNumber: 3, rarityCanonical: 'SECRET_RARE', verified: true },
  { setPrefix: 'RA01', variantNumber: 4, rarityCanonical: 'PLATINUM_SECRET_RARE', verified: true },
  { setPrefix: 'RA01', variantNumber: 5, rarityCanonical: 'QUARTER_CENTURY_SECRET_RARE', verified: true },
  { setPrefix: 'RA01', variantNumber: 6, rarityCanonical: 'COLLECTORS_RARE', verified: true },
  { setPrefix: 'RA01', variantNumber: 7, rarityCanonical: 'ULTIMATE_RARE', verified: true },
  { setPrefix: 'RA02', variantNumber: 1, rarityCanonical: 'SUPER_RARE', verified: true },
  { setPrefix: 'RA02', variantNumber: 2, rarityCanonical: 'ULTRA_RARE', verified: true },
  { setPrefix: 'RA02', variantNumber: 3, rarityCanonical: 'SECRET_RARE', verified: true },
  { setPrefix: 'RA02', variantNumber: 4, rarityCanonical: 'PLATINUM_SECRET_RARE', verified: true },
  { setPrefix: 'RA02', variantNumber: 5, rarityCanonical: 'QUARTER_CENTURY_SECRET_RARE', verified: true },
  { setPrefix: 'RA02', variantNumber: 6, rarityCanonical: 'COLLECTORS_RARE', verified: true },
  { setPrefix: 'RA02', variantNumber: 7, rarityCanonical: 'ULTIMATE_RARE', verified: true }
];

// Caso reale (sezione 12 del task): RA01-EN061, 7 candidati osservati.
const RA01_CANDIDATES = ['741693', '741694', '741695', '741696', '741697', '741698', '741699'];
// Caso reale RA02-EN024 (Garura), 7 candidati con id completamente diversi —
// prova che il resolver usa la POSIZIONE, mai il valore numerico dell'id.
const RA02_CANDIDATES = ['769701', '769782', '769863', '769950', '770032', '770113', '770194'];

// 1-7) RA01: ogni rarity -> il candidato alla posizione V.n corretta.
{
  const expected = { SUPER_RARE: '741693', ULTRA_RARE: '741694', SECRET_RARE: '741695', PLATINUM_SECRET_RARE: '741696', QUARTER_CENTURY_SECRET_RARE: '741697', COLLECTORS_RARE: '741698', ULTIMATE_RARE: '741699' };
  for (const [rarity, expectedProductId] of Object.entries(expected)) {
    const result = resolveYgoMarketVariantBySetTemplate({ setCode: 'RA01-EN061', rarityCanonical: rarity, candidateProductIds: RA01_CANDIDATES, setTemplates: RA_TEMPLATE });
    assert.ok(result, `RA01 ${rarity} doveva risolvere`);
    assert.equal(result.productId, expectedProductId, `RA01 ${rarity} -> atteso ${expectedProductId}, ottenuto ${result.productId}`);
  }
  console.log('PASS RA01: tutte e 7 le rarity risolvono al candidato nella posizione V.n corretta (741693..741699)');
}

// 8) RA02: stesso mapping astratto, id completamente diversi — Ultra Rare
//    deve risolvere al SECONDO candidato (posizione, non valore numerico).
{
  const result = resolveYgoMarketVariantBySetTemplate({ setCode: 'RA02-EN024', rarityCanonical: 'ULTRA_RARE', candidateProductIds: RA02_CANDIDATES, setTemplates: RA_TEMPLATE });
  assert.equal(result.productId, '769782', 'RA02 Ultra Rare deve essere il secondo candidato (769782), non il primo né un id "vicino" numericamente');
  console.log('PASS RA02: Ultra Rare risolve al secondo candidato per posizione, id completamente diversi da RA01');
}

// 9) RA05 — noto instabile, NESSUN template seedato -> mai una risoluzione.
{
  const result = resolveYgoMarketVariantBySetTemplate({ setCode: 'RA05-IT063', rarityCanonical: 'ULTRA_RARE', candidateProductIds: RA01_CANDIDATES, setTemplates: RA_TEMPLATE });
  assert.equal(result, null, 'RA05 non è whitelisted: nessuna risoluzione, mai un guess');
}
// 10) RA03 — stesso discorso, nessun dato -> nessuna risoluzione.
{
  const result = resolveYgoMarketVariantBySetTemplate({ setCode: 'RA03-EN012', rarityCanonical: 'SUPER_RARE', candidateProductIds: RA01_CANDIDATES, setTemplates: RA_TEMPLATE });
  assert.equal(result, null, 'RA03 non è whitelisted: nessuna risoluzione');
}
console.log('PASS RA03/RA05 (non whitelisted): nessuna risoluzione, il whitelisting emerge SOLO dai dati verified=true, non da un pattern sul prefisso');

// 11) Template esiste ma non verified -> nessuna risoluzione.
{
  const unverifiedTemplate = [{ setPrefix: 'RA09', variantNumber: 1, rarityCanonical: 'SUPER_RARE', verified: false }];
  const result = resolveYgoMarketVariantBySetTemplate({ setCode: 'RA09-EN001', rarityCanonical: 'SUPER_RARE', candidateProductIds: ['1', '2'], setTemplates: unverifiedTemplate });
  assert.equal(result, null, 'template non verified: mai una risoluzione automatica');
}
// 12) Rarity non presente nel template per quel set -> nessuna risoluzione.
{
  const result = resolveYgoMarketVariantBySetTemplate({ setCode: 'RA01-EN061', rarityCanonical: 'STARLIGHT_RARE', candidateProductIds: RA01_CANDIDATES, setTemplates: RA_TEMPLATE });
  assert.equal(result, null, 'rarity assente dal template: nessuna risoluzione');
}
// 13) Candidate array troppo corto per la posizione richiesta (QCSR è V.5, solo 3 candidati) -> nessuna risoluzione.
{
  const result = resolveYgoMarketVariantBySetTemplate({ setCode: 'RA01-EN061', rarityCanonical: 'QUARTER_CENTURY_SECRET_RARE', candidateProductIds: ['a', 'b', 'c'], setTemplates: RA_TEMPLATE });
  assert.equal(result, null, 'array troppo corto per la posizione: mai un fallback, mai un indice fuori range');
}
// 14) Candidate array vuoto -> nessuna risoluzione.
{
  const result = resolveYgoMarketVariantBySetTemplate({ setCode: 'RA01-EN061', rarityCanonical: 'SUPER_RARE', candidateProductIds: [], setTemplates: RA_TEMPLATE });
  assert.equal(result, null, 'array vuoto: nessuna risoluzione');
}
console.log('PASS non-resolution: template non verified, rarity assente, candidate array corto/vuoto -> sempre null, mai un guess');

// Duplicate/ambiguous template rows (difesa in profondità: il DB ha un
// vincolo unique, ma la funzione pura non si fida e rifiuta comunque).
{
  const ambiguousTemplate = [
    { setPrefix: 'RA09', variantNumber: 1, rarityCanonical: 'SUPER_RARE', verified: true },
    { setPrefix: 'RA09', variantNumber: 2, rarityCanonical: 'SUPER_RARE', verified: true }
  ];
  const result = resolveYgoMarketVariantBySetTemplate({ setCode: 'RA09-EN001', rarityCanonical: 'SUPER_RARE', candidateProductIds: ['1', '2', '3'], setTemplates: ambiguousTemplate });
  assert.equal(result, null, 'righe template duplicate/ambigue per la stessa rarity: mai una scelta arbitraria tra le due');
}
console.log('PASS duplicate/ambiguous template rows: nessuna risoluzione anche se il DB dovesse mai permetterle');

// --- Integrazione in resolveYgoMarketVariant(): priorità rispettata -------

// 15) manual verified mapping preservato anche se un template matcherebbe.
{
  const result = resolveYgoMarketVariant({
    existingVariant: { verified: true, mapping_source: 'manual', cardmarket_product_id: 'MANUAL-PICK' },
    cardmarketCandidates: RA01_CANDIDATES.map(id => ({ productId: id, expansionId: 'RA01-EXP' })),
    rarityCanonical: 'ULTRA_RARE', setCode: 'RA01-EN061', setTemplates: RA_TEMPLATE
  });
  assert.equal(result.mappingStatus, MARKET_VARIANT_STATUS.VERIFIED);
  assert.equal(result.cardmarketProductId, 'MANUAL-PICK', 'un mapping manual verified non deve mai essere sovrascritto dal set template, anche se il template indicherebbe un altro prodotto');
}
// 16) existing resolved-registry mapping (stabile, non forceRefresh) preservato.
{
  const result = resolveYgoMarketVariant({
    existingVariant: { mapping_status: 'resolved', mapping_source: 'resolver', cardmarket_product_id: 'REGISTRY-PICK', mapping_confidence: 0.6 },
    cardmarketCandidates: RA01_CANDIDATES.map(id => ({ productId: id, expansionId: 'RA01-EXP' })),
    rarityCanonical: 'ULTRA_RARE', setCode: 'RA01-EN061', setTemplates: RA_TEMPLATE
  });
  assert.equal(result.cardmarketProductId, 'REGISTRY-PICK', 'una risoluzione registry già stabile non deve essere ricalcolata dal set template senza forceRefresh');
}
console.log('PASS priorità: manual verified ed existing resolved-registry restano intoccati anche quando un set template applicherebbe');

// Integrazione positiva: nessun existingVariant -> il set template si applica
// come step 3, con mapping_source/status/confidence corretti e MAI verified=true.
{
  const result = resolveYgoMarketVariant({
    cardmarketCandidates: RA01_CANDIDATES.map(id => ({ productId: id, expansionId: 'RA01-EXP' })),
    rarityCanonical: 'SUPER_RARE', setCode: 'RA01-EN061', setTemplates: RA_TEMPLATE
  });
  assert.equal(result.mappingStatus, MARKET_VARIANT_STATUS.RESOLVED);
  assert.equal(result.mappingSource, MARKET_VARIANT_SOURCE.SET_TEMPLATE);
  assert.equal(result.mappingConfidence, 1);
  assert.equal(result.cardmarketProductId, '741693');
  assert.equal(result.verified, false, 'una risoluzione da set template non deve MAI impostare verified=true da sola');
  assert.equal(result.reason, 'verified_set_variant_template');
  // 20) candidate_product_ids invariati (stesso ordine, stesso contenuto).
  assert.deepEqual(result.candidateProductIds, RA01_CANDIDATES);
}
console.log('PASS resolveYgoMarketVariant applica il set template come step 3: resolved/verified_set_template/confidence 1, mai verified=true, candidate_product_ids invariati');

// Per un set NON whitelisted, resolveYgoMarketVariant deve comportarsi
// esattamente come prima di questa estensione (nessuna regressione): con
// più candidati e nessuna rarity nel feed, resta ambiguous.
{
  const result = resolveYgoMarketVariant({
    cardmarketCandidates: [{ productId: 'x1', expansionId: 'E1' }, { productId: 'x2', expansionId: 'E1' }],
    rarityCanonical: 'ULTRA_RARE', setCode: 'RA05-IT063', setTemplates: RA_TEMPLATE
  });
  assert.equal(result.mappingStatus, MARKET_VARIANT_STATUS.AMBIGUOUS);
  assert.equal(result.cardmarketProductId, null);
}
console.log('PASS RA05 dentro resolveYgoMarketVariant: nessun template applicabile, comportamento identico a prima (ambiguous, nessuna scelta)');

console.log('PASS market variant set template resolver: RA01/RA02 risolvono per posizione, RA03/RA05 mai, tutte le non-resolution rispettate, priorità preservata, mai verified=true');
