// Copre resolveYgoMarketVariantBySetTemplate() (resolver deterministico
// V.n -> rarity per set esplicitamente whitelisted) e la sua integrazione in
// resolveYgoMarketVariant() (priorità: manual verified > verified registry >
// set template > exact resolver logic > ambiguous/conflict/unresolved).
import assert from 'node:assert/strict';
import { resolveYgoMarketVariant, resolveYgoMarketVariantBySetTemplate, MARKET_VARIANT_STATUS, MARKET_VARIANT_SOURCE } from '../market/providers.js';
import { SET_TEMPLATE_SEED } from '../market/set-template-seed.js';

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

// 9) RA03 senza template nel set passato -> nessuna risoluzione (il
//    whitelisting emerge solo dai dati, mai dal prefisso).
{
  const result = resolveYgoMarketVariantBySetTemplate({ setCode: 'RA03-EN012', rarityCanonical: 'SUPER_RARE', candidateProductIds: RA01_CANDIDATES, setTemplates: RA_TEMPLATE });
  assert.equal(result, null, 'RA03 non è nel template passato: nessuna risoluzione');
}
console.log('PASS set assente dal template: nessuna risoluzione, il whitelisting emerge SOLO dai dati verified=true');

// 10) RA05 con il seed reale (migration 20261012130000). Product id veri dal
//     feed Cardmarket del 2026-10-12: Imsety RA05-IT027 880830..880836,
//     PSY-Framegear Delta RA05-IT007 880595..880601, Solemn Warning
//     RA05-EN126 (solo Ultra + Starlight) 881377/881378.
const IMSETY = ['880830', '880831', '880832', '880833', '880834', '880835', '880836'];
const DELTA = ['880595', '880596', '880597', '880598', '880599', '880600', '880601'];
const SOLEMN = ['881377', '881378'];
{
  const expected = { SUPER_RARE: '880830', ULTRA_RARE: '880831', SECRET_RARE: '880832', PLATINUM_SECRET_RARE: '880833', STARLIGHT_RARE: '880834', COLLECTORS_RARE: '880835', ULTIMATE_RARE: '880836' };
  for (const [rarity, productId] of Object.entries(expected)) {
    const result = resolveYgoMarketVariantBySetTemplate({ setCode: 'RA05-IT027', rarityCanonical: rarity, candidateProductIds: IMSETY, setTemplates: SET_TEMPLATE_SEED });
    assert.equal(result?.productId, productId, `Imsety RA05-IT027 ${rarity} -> atteso ${productId}`);
  }
  const delta = resolveYgoMarketVariantBySetTemplate({ setCode: 'RA05-IT007', rarityCanonical: 'STARLIGHT_RARE', candidateProductIds: DELTA, setTemplates: SET_TEMPLATE_SEED });
  assert.equal(delta?.productId, '880599', 'Delta RA05-IT007 Starlight deve essere V.5 (880599), non la Ultra né il minimo');
  console.log('PASS RA05 a 7 candidati: Imsety IT027 tutte e 7 le rarità, Delta IT007 Starlight -> V.5');
}
// 11) RA05 a 2 candidati (Ultra + Starlight): V.2 è la Starlight. Senza
//     candidateCount il template a 7 avrebbe letto V.2 come Ultra.
{
  const ultra = resolveYgoMarketVariantBySetTemplate({ setCode: 'RA05-EN126', rarityCanonical: 'ULTRA_RARE', candidateProductIds: SOLEMN, setTemplates: SET_TEMPLATE_SEED });
  const starlight = resolveYgoMarketVariantBySetTemplate({ setCode: 'RA05-EN126', rarityCanonical: 'STARLIGHT_RARE', candidateProductIds: SOLEMN, setTemplates: SET_TEMPLATE_SEED });
  assert.equal(ultra?.productId, '881377');
  assert.equal(starlight?.productId, '881378');
  const secret = resolveYgoMarketVariantBySetTemplate({ setCode: 'RA05-EN126', rarityCanonical: 'SECRET_RARE', candidateProductIds: SOLEMN, setTemplates: SET_TEMPLATE_SEED });
  assert.equal(secret, null, 'nessuna Secret nelle carte a 2 rarità: mai un indice preso dal template a 7');
  console.log('PASS RA05 a 2 candidati: Ultra V.1, Starlight V.2, nessuna confusione col template a 7');
}
// 12) Numero di candidati senza template (6 rarità, 9 prodotti) -> nessuna
//     risoluzione, mai un fallback al template a 7.
{
  for (const ids of [IMSETY.slice(0, 6), [...IMSETY, '900001', '900002']]) {
    for (const rarity of ['SUPER_RARE', 'ULTRA_RARE', 'COLLECTORS_RARE', 'STARLIGHT_RARE']) {
      const result = resolveYgoMarketVariantBySetTemplate({ setCode: 'RA05-IT042', rarityCanonical: rarity, candidateProductIds: ids, setTemplates: SET_TEMPLATE_SEED });
      assert.equal(result, null, `RA05 con ${ids.length} candidati, ${rarity}: nessun template applicabile`);
    }
  }
  console.log('PASS RA05 con 6 o 9 candidati: nessuna risoluzione');
}
// 13) RA03/RA04: template a 7 come RA01, carte a 2 rarità PSR V.1 / QCSR V.2,
//     RA04 a 1 candidato solo QCSR.
{
  assert.equal(resolveYgoMarketVariantBySetTemplate({ setCode: 'RA03-EN001', rarityCanonical: 'QUARTER_CENTURY_SECRET_RARE', candidateProductIds: RA01_CANDIDATES, setTemplates: SET_TEMPLATE_SEED })?.productId, '741697');
  assert.equal(resolveYgoMarketVariantBySetTemplate({ setCode: 'RA04-EN001', rarityCanonical: 'ULTIMATE_RARE', candidateProductIds: RA01_CANDIDATES, setTemplates: SET_TEMPLATE_SEED })?.productId, '741699');
  assert.equal(resolveYgoMarketVariantBySetTemplate({ setCode: 'RA03-EN100', rarityCanonical: 'QUARTER_CENTURY_SECRET_RARE', candidateProductIds: ['a', 'b'], setTemplates: SET_TEMPLATE_SEED })?.productId, 'b');
  assert.equal(resolveYgoMarketVariantBySetTemplate({ setCode: 'RA04-EN100', rarityCanonical: 'PLATINUM_SECRET_RARE', candidateProductIds: ['a', 'b'], setTemplates: SET_TEMPLATE_SEED })?.productId, 'a');
  assert.equal(resolveYgoMarketVariantBySetTemplate({ setCode: 'RA04-EN200', rarityCanonical: 'QUARTER_CENTURY_SECRET_RARE', candidateProductIds: ['solo'], setTemplates: SET_TEMPLATE_SEED })?.productId, 'solo');
  assert.equal(resolveYgoMarketVariantBySetTemplate({ setCode: 'RA03-EN200', rarityCanonical: 'QUARTER_CENTURY_SECRET_RARE', candidateProductIds: ['solo'], setTemplates: SET_TEMPLATE_SEED }), null, 'RA03 non ha un template a 1 candidato');
  console.log('PASS RA03/RA04: 7 candidati come RA01, 2 candidati PSR/QCSR, RA04 a 1 candidato solo QCSR');
}
// 14) RA01/RA02 nel seed hanno candidateCount assente: valgono per qualunque
//     numero di candidati, comportamento originale invariato.
{
  assert.equal(resolveYgoMarketVariantBySetTemplate({ setCode: 'RA01-EN061', rarityCanonical: 'ULTIMATE_RARE', candidateProductIds: RA01_CANDIDATES, setTemplates: SET_TEMPLATE_SEED })?.productId, '741699');
  console.log('PASS RA01 col seed completo: invariato');
}

// Template esiste ma non verified -> nessuna risoluzione.
{
  const unverifiedTemplate = [{ setPrefix: 'RA09', variantNumber: 1, rarityCanonical: 'SUPER_RARE', verified: false }];
  const result = resolveYgoMarketVariantBySetTemplate({ setCode: 'RA09-EN001', rarityCanonical: 'SUPER_RARE', candidateProductIds: ['1', '2'], setTemplates: unverifiedTemplate });
  assert.equal(result, null, 'template non verified: mai una risoluzione automatica');
}
// Rarity non presente nel template per quel set -> nessuna risoluzione.
{
  const result = resolveYgoMarketVariantBySetTemplate({ setCode: 'RA01-EN061', rarityCanonical: 'STARLIGHT_RARE', candidateProductIds: RA01_CANDIDATES, setTemplates: RA_TEMPLATE });
  assert.equal(result, null, 'rarity assente dal template: nessuna risoluzione');
}
// Candidate array troppo corto per la posizione richiesta (QCSR è V.5, solo 3 candidati) -> nessuna risoluzione.
{
  const result = resolveYgoMarketVariantBySetTemplate({ setCode: 'RA01-EN061', rarityCanonical: 'QUARTER_CENTURY_SECRET_RARE', candidateProductIds: ['a', 'b', 'c'], setTemplates: RA_TEMPLATE });
  assert.equal(result, null, 'array troppo corto per la posizione: mai un fallback, mai un indice fuori range');
}
// Candidate array vuoto -> nessuna risoluzione.
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
    rarityCanonical: 'ULTRA_RARE', setCode: 'RA09-IT063', setTemplates: SET_TEMPLATE_SEED
  });
  assert.equal(result.mappingStatus, MARKET_VARIANT_STATUS.AMBIGUOUS);
  assert.equal(result.cardmarketProductId, null);
}
console.log('PASS set non whitelisted dentro resolveYgoMarketVariant: nessun template applicabile, comportamento identico a prima (ambiguous, nessuna scelta)');

// Imsety Starlight dentro resolveYgoMarketVariant: resolved con confidence 1
// (quella che il pricing live per variante esatta richiede), mai verified.
{
  const result = resolveYgoMarketVariant({
    cardmarketCandidates: IMSETY.map(id => ({ productId: id, expansionId: '6424' })),
    rarityCanonical: 'STARLIGHT_RARE', setCode: 'RA05-IT027', setTemplates: SET_TEMPLATE_SEED
  });
  assert.equal(result.mappingStatus, MARKET_VARIANT_STATUS.RESOLVED);
  assert.equal(result.mappingSource, MARKET_VARIANT_SOURCE.SET_TEMPLATE);
  assert.equal(result.mappingConfidence, 1);
  assert.equal(result.cardmarketProductId, '880834');
  assert.equal(result.verified, false);
}
console.log('PASS Imsety RA05-IT027 Starlight: resolved via set template, product 880834, confidence 1, mai verified');

console.log('PASS market variant set template resolver: RA01-RA05 risolvono per posizione e numero di candidati, tutte le non-resolution rispettate, priorità preservata, mai verified=true');
