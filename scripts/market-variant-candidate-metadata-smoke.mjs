// Copre le funzioni pure dell'arricchimento metadata candidati Cardmarket
// (market/providers.js): parsing del titolo pagina prodotto, classificazione
// dell'esito del fetch (incluso 403/429 -> blocked, senza crash), match
// rarity FPT-vs-Cardmarket, guardrail cache/batch. Nessuna rete coinvolta —
// il fetch reale è stato testato UNA volta con WebFetch verso
// cardmarket.com (idProduct e la home category) ed è tornato HTTP 403 su
// entrambe: queste funzioni sono progettate per gestire correttamente
// proprio quell'esito, non per garantire che il fetch funzioni in produzione.
import assert from 'node:assert/strict';
import {
  parseCardmarketProductTitle, classifyCandidateMetadataFetchOutcome, classifyCandidateRarityMatch,
  classifyCandidatePoolMatch, shouldRefreshCandidateMetadata, validateCandidateMetadataBatch
} from '../market/providers.js';

// 1) parsing "V.1 - Ultra Rare"
{
  const r = parseCardmarketProductTitle('Garura, Wings of Resonant Life (V.1 - Ultra Rare)');
  assert.equal(r.productName, 'Garura, Wings of Resonant Life');
  assert.equal(r.variantNumber, '1');
  assert.equal(r.rarityRaw, 'Ultra Rare');
}
// 2) parsing "V.2 - Secret Rare", con suffisso sito da rimuovere
{
  const r = parseCardmarketProductTitle('Garura, Wings of Resonant Life (V.2 - Secret Rare) | Cardmarket');
  assert.equal(r.variantNumber, '2');
  assert.equal(r.rarityRaw, 'Secret Rare');
}
// 3) rarity sconosciuta: nessun suffisso (V.N - ...) -> rarityRaw null, mai un guess
{
  const r = parseCardmarketProductTitle('Garura, Wings of Resonant Life');
  assert.equal(r.rarityRaw, null);
  assert.equal(r.variantNumber, null);
  assert.equal(r.productName, 'Garura, Wings of Resonant Life');
}
// markup/testo non riconoscibile (titolo vuoto) -> tutto null/vuoto, mai un errore
{
  const r = parseCardmarketProductTitle('');
  assert.deepEqual(r, { productName: '', variantNumber: null, rarityRaw: null });
}
console.log('PASS parseCardmarketProductTitle: V.1/V.2 riconosciuti, rarity sconosciuta e titolo vuoto restano null, mai un guess');

// 4) markup non riconosciuto (titolo mai trovato nell'HTML) -> parse_error
assert.equal(classifyCandidateMetadataFetchOutcome({ titleFound: false }), 'parse_error');
// eccezione lanciata durante il fetch/parsing -> parse_error
assert.equal(classifyCandidateMetadataFetchOutcome({ threwError: true }), 'parse_error');
// 15) 403/429 -> blocked, senza eccezioni
assert.equal(classifyCandidateMetadataFetchOutcome({ httpStatus: 403, titleFound: false }), 'blocked');
assert.equal(classifyCandidateMetadataFetchOutcome({ httpStatus: 429, titleFound: false }), 'blocked');
assert.equal(classifyCandidateMetadataFetchOutcome({ httpStatus: 503 }), 'blocked');
assert.equal(classifyCandidateMetadataFetchOutcome({ httpStatus: 404 }), 'not_found');
// titolo trovato ma senza il pattern (V.N - Rarity) -> incomplete, non resolved
assert.equal(classifyCandidateMetadataFetchOutcome({ httpStatus: 200, titleFound: true, rarityRaw: null }), 'incomplete');
// titolo + rarity trovati -> resolved
assert.equal(classifyCandidateMetadataFetchOutcome({ httpStatus: 200, titleFound: true, rarityRaw: 'Ultra Rare' }), 'resolved');
console.log('PASS classifyCandidateMetadataFetchOutcome: 403/429/5xx->blocked, 404->not_found, eccezione/titolo assente->parse_error, mai una crash');

// 8) exact visual match / 9) mismatch / 10) unknown
assert.equal(classifyCandidateRarityMatch('ULTRA_RARE', 'ULTRA_RARE'), 'exact_match');
assert.equal(classifyCandidateRarityMatch('ULTRA_RARE', 'SUPER_RARE'), 'mismatch');
assert.equal(classifyCandidateRarityMatch('ULTRA_RARE', null), 'unknown');
assert.equal(classifyCandidateRarityMatch(null, 'ULTRA_RARE'), 'unknown');
console.log('PASS classifyCandidateRarityMatch: exact_match/mismatch/unknown corretti, mai un\'auto-conferma (nessun side effect, solo un\'etichetta)');

// Sezione 18 — pool match: exact_unique/multiple_matches/no_match/unknown, MAI verified.
{
  // 7 candidati come RA02-EN024, uno solo canonicalizzato come Ultra Rare -> exact_unique
  const candidates = [
    { rarityCanonical: null }, { rarityCanonical: 'ULTRA_RARE' }, { rarityCanonical: null },
    { rarityCanonical: null }, { rarityCanonical: null }, { rarityCanonical: null }, { rarityCanonical: null }
  ];
  assert.equal(classifyCandidatePoolMatch('ULTRA_RARE', candidates), 'exact_unique');
}
{
  const candidates = [{ rarityCanonical: 'ULTRA_RARE' }, { rarityCanonical: 'ULTRA_RARE' }, { rarityCanonical: 'SUPER_RARE' }];
  assert.equal(classifyCandidatePoolMatch('ULTRA_RARE', candidates), 'multiple_matches');
}
{
  const candidates = [{ rarityCanonical: 'SUPER_RARE' }, { rarityCanonical: 'SECRET_RARE' }];
  assert.equal(classifyCandidatePoolMatch('ULTRA_RARE', candidates), 'no_match');
}
assert.equal(classifyCandidatePoolMatch('ULTRA_RARE', [{ rarityCanonical: null }, { rarityCanonical: null }]), 'unknown');
assert.equal(classifyCandidatePoolMatch(null, [{ rarityCanonical: 'ULTRA_RARE' }]), 'unknown');
console.log('PASS classifyCandidatePoolMatch: exact_unique/multiple_matches/no_match/unknown, mai verified=true (nessun campo del genere nel risultato)');

// 12) cache hit -> zero fetch (rappresentato come "non serve refresh")
assert.equal(shouldRefreshCandidateMetadata(new Date().toISOString(), false), false, 'appena controllato, cache calda: non deve rifetchare');
// 13) stale cache -> fetch consentito
{
  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  assert.equal(shouldRefreshCandidateMetadata(eightDaysAgo, false), true, 'oltre 7 giorni: refresh consentito');
}
assert.equal(shouldRefreshCandidateMetadata(new Date().toISOString(), true), true, 'force=true rifetcha anche se la cache è calda');
assert.equal(shouldRefreshCandidateMetadata(null, false), true, 'mai controllato prima: refresh consentito');
console.log('PASS shouldRefreshCandidateMetadata: cache <7gg salta il fetch, >7gg o force=true lo consente');

// 14) batch limit rispettato
assert.deepEqual(validateCandidateMetadataBatch(['p1', 'p2'], ['a', 'b', 'c']), { ok: true, printingCount: 2, productCount: 3 });
assert.equal(validateCandidateMetadataBatch([], []).ok, false);
assert.equal(validateCandidateMetadataBatch(['p1', 'p2', 'p3', 'p4', 'p5', 'p6'], []).reason, 'too_many_printings');
assert.equal(validateCandidateMetadataBatch(['p1'], Array.from({ length: 41 }, (_, i) => `id${i}`)).reason, 'too_many_product_ids');
console.log('PASS validateCandidateMetadataBatch: max 5 printing / max 40 product_id rispettati, mai superati silenziosamente');

console.log('PASS candidate metadata enrichment (funzioni pure): parsing, fetch outcome, rarity match, cache/batch guardrail');
