// Grammatica dei codici Konami nella Fast Scan (2026-10-13).
// Regola verificata sui 39.200 codici di ygo_printcode_entries: prefisso 3-4
// caratteri, trattino, lingua di 2 lettere, poi SEMPRE 3 caratteri (999 96,6%,
// A99, AA9); eccezioni storiche MIK-I022 e LOB-001. Usata per generare e
// ordinare i candidati OCR, mai per allentare l'accettazione automatica.
import assert from 'node:assert/strict';
globalThis.window ??= globalThis;
globalThis.localStorage ??= { getItem() { return null; }, setItem() {}, removeItem() {} };
const { conformsToSetCodeGrammar, setCodeCandidates, normalizeSetCode } = await import('../js/fast-scan-core.js');

// 1. Forme reali (dal catalogo) e forme impossibili.
for (const code of ['PGLD-IT021', 'AP06-IT019', 'DP1-EN015', 'RA05-IT027', 'L5DD-ENC02', 'YS13-ITV01', 'CORE-ITSP1', '5DS1-IT013', 'MIK-I022', 'LOB-001', 'LC5D-EN245'])
  assert(conformsToSetCodeGrammar(code), `${code} è un codice reale e deve rispettare la grammatica`);
for (const code of ['PGLD-IT0211', 'XPGLD-IT021', 'PGLD-EH021', 'PG-IT021', 'PGLD-IT02', '1234-IT021', 'PGLD-IT0O1'])
  assert(!conformsToSetCodeGrammar(code), `${code} non può esistere`);

const rank = (raw, code) => setCodeCandidates(raw).findIndex(item => item.code === code);
const find = (raw, code) => setCodeCandidates(raw).find(item => item.code === code);

// 2. Lettera nella coda dove serve una cifra: correzione controllata, in cima.
for (const [raw, code] of [['PGLD-IT02S', 'PGLD-IT025'], ['PGLD-IT0B1', 'PGLD-IT081'], ['PGLD-IT0Z1', 'PGLD-IT021']]) {
  assert.equal(rank(raw, code), 1, `${raw}: ${code} deve essere il primo candidato corretto`);
  assert.equal(find(raw, code).requiresReview, false, `${raw}: lettera→cifra a 1 edit è una confusione OCR controllata`);
}

// 3. Lingua inesistente agganciata alla più vicina: trovata, ma sempre da confermare.
const eh = find('PGLD-EH021', 'PGLD-EN021');
assert(eh, 'PGLD-EH021 deve proporre PGLD-EN021 (prima non veniva mai trovato)');
assert.equal(eh.requiresReview, true, 'una lingua agganciata non deve mai bastare per una conferma automatica');

// 4. Caratteri in più: coda oltre 3 o prefisso oltre 4 → candidato valido in alto, da confermare.
for (const [raw, code] of [['PGLD-IT0211', 'PGLD-IT021'], ['XPGLD-IT021', 'PGLD-IT021']]) {
  const index = rank(raw, code);
  assert(index > 0 && index <= 3, `${raw}: ${code} deve stare tra i primi candidati (posizione ${index})`);
  assert.equal(find(raw, code).requiresReview, true, `${raw}: togliere caratteri è una supposizione, va confermata`);
}

// 5. Trattino perso + lettera nel numero: ricostruito, ma mai trattato come lettura esatta.
const lost = normalizeSetCode('PGL3ITO13');
assert.equal(lost.code, 'PGL3-IT013', 'PGL3ITO13 deve diventare PGL3-IT013 (prima non veniva ricostruito)');
assert.equal(lost.reconstructedSeparator, true, 'la ricostruzione con correzione resta un\'ipotesi');
// Un trattino perso su un codice pulito resta una lettura sicura come prima.
const clean = normalizeSetCode('PGL3IT013');
assert.equal(clean.code, 'PGL3-IT013');
assert.equal(clean.reconstructedSeparator, false, 'trattino perso su codice pulito: niente revisione in più');

console.log('PASS grammatica codici Konami: forme reali/impossibili · lettera→cifra in coda in cima · lingua agganciata e caratteri tolti sempre da confermare · trattino perso + errore nel numero ricostruito');
