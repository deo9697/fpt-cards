// Leader multicolore: il catalogo riceve i colori come "Green Yellow" (con lo spazio).
// Prima del fix ogni carta verde o gialla risultava "colore non compatibile con il Leader"
// (segnalato dal team il 2026-11-10 con Nico Robin EB05-010).
import assert from 'node:assert/strict';
import { validateSimulatorDeck } from '../js/games/onepiece/simulator-engine.js';
import { validateOnePieceDeck, splitOnePieceColors, summarizeDeckErrors } from '../js/games/onepiece/rules.js';
import { normalizeColorList } from '../supabase/functions/onepiece-catalog-sync/normalizer.mjs';

const deck = (leaderColors, mainColors) => ({
  id: 'deck-robin', name: 'Robin', game: 'onepiece',
  cards: [
    { catalogCardId: 'EB05-010', cardName: 'Nico Robin (010)', section: 'leader', quantity: 1, colors: leaderColors },
    ...mainColors.map((colors, index) => ({ catalogCardId: `EB05-${String(index + 20).padStart(3, '0')}`, cardName: `Carta ${index}`, section: 'main', quantity: index < 12 ? 4 : 2, colors })),
  ],
});
const greenYellow = Array.from({ length: 13 }, (_, i) => (i % 3 === 0 ? ['Green'] : i % 3 === 1 ? ['Yellow'] : ['Green Yellow']));
const colourErrors = result => result.errors.filter(error => /colore non compatibile/.test(error));

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log('PASS ' + name); };

check('i colori del catalogo vengono separati e normalizzati', () => {
  assert.deepEqual(splitOnePieceColors(['Green Yellow']), ['green', 'yellow']);
  assert.deepEqual(splitOnePieceColors(['Red', 'Green']), ['red', 'green']);
  assert.deepEqual(splitOnePieceColors(['Blue Green Purple Red Black Yellow']).length, 6);
  assert.deepEqual(splitOnePieceColors(['Character']), []);
  assert.deepEqual(normalizeColorList('Green Yellow'), ['Green', 'Yellow']);
});

check('simulatore: Leader "Green Yellow" accetta carte verdi, gialle e verde-gialle', () => {
  const result = validateSimulatorDeck(deck(['Green Yellow'], greenYellow));
  assert.deepEqual(colourErrors(result), []);
  assert.equal(result.valid, true, result.errors.join(' | '));
});

check('deck builder: stesso mazzo senza errori di colore', () => {
  assert.deepEqual(colourErrors(validateOnePieceDeck(deck(['Green Yellow'], greenYellow))), []);
});

check('una carta rossa resta vietata con il Leader verde-giallo', () => {
  const mixed = greenYellow.slice(); mixed[0] = ['Red'];
  assert.equal(colourErrors(validateSimulatorDeck(deck(['Green Yellow'], mixed))).length, 1);
  assert.equal(colourErrors(validateOnePieceDeck(deck(['Green Yellow'], mixed))).length, 1);
});

check('gli errori mostrati sono riassunti in poche righe', () => {
  assert.deepEqual(summarizeDeckErrors(['a', 'b']), ['a', 'b']);
  assert.deepEqual(summarizeDeckErrors(['a', 'b', 'c', 'd', 'e']), ['a', 'b', 'c', '…e altri 2 problemi.']);
});

console.log(`One Piece Leader multicolore: ${passed}/${passed} PASS`);
