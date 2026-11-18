// Regression (2026-11-18): practice/automatic duels always started with the
// same hand because the Deck was never shuffled before duelNewCard.
// Checks: different seeds → different opening hands; same seed → identical
// hand (replay from seed + transcript must stay deterministic); states created
// before the fix (no deckShuffle flag) keep their original unshuffled order.
import assert from 'node:assert/strict';
import { createAutoState, seededDeckOrder, DECK_SHUFFLE_VERSION } from '../api/_yugioh-auto-core.js';
import { loadAutoResources } from '../api/_yugioh-auto-resources.js';
import { OcgType } from 'ocgcore-wasm';

const resources = await loadAutoResources();
const normal = [...resources.cards.values()].filter(card => (card.ot & 2) && card.type === (OcgType.MONSTER | OcgType.NORMAL) && card.level <= 4 && card.attack > 0).slice(0, 40).map(card => card.code);
const deck = { name: 'Prova', main: normal };
const hand = state => (state.publicViews?.[0]?.players?.[0]?.hand || []).map(card => card.code || card.catalogCardId || card.cardName).join(',');
const seed = n => n.repeat(64).slice(0, 64);

// Unit: the permutation is a real shuffle, deterministic and per-controller.
const order = seededDeckOrder(normal, seed('a1'), 0);
assert.equal(order.length, normal.length);
assert.deepEqual([...order].sort(), [...normal].sort(), 'stesse carte, solo in altro ordine');
assert.notDeepEqual(order, normal, 'il mazzo deve essere mescolato');
assert.deepEqual(seededDeckOrder(normal, seed('a1'), 0), order, 'stesso seme = stesso ordine');
assert.notDeepEqual(seededDeckOrder(normal, seed('a1'), 1), order, 'i due giocatori hanno ordini indipendenti');
console.log('PASS mescolamento: permutazione completa, deterministica dal seme, indipendente per giocatore');

// Engine: different seeds give different opening hands.
const hands = [];
for (const s of ['1f', '2e', '3d', '4c']) {
  const state = await createAutoState({ decks: [deck, deck], names: ['A', 'B'], firstPlayer: 0, lp: [8000, 8000], seed: seed(s), passivePlayer: 1 });
  assert.equal(state.deckShuffle, DECK_SHUFFLE_VERSION, 'le partite nuove registrano il mescolamento');
  hands.push(hand(state));
}
assert(new Set(hands).size >= 3, 'semi diversi devono dare mani diverse: ' + JSON.stringify(hands));
const again = await createAutoState({ decks: [deck, deck], names: ['A', 'B'], firstPlayer: 0, lp: [8000, 8000], seed: seed('1f'), passivePlayer: 1 });
assert.equal(hand(again), hands[0], 'stesso seme = stessa mano (ricostruzione deterministica)');
console.log('PASS motore: mani diverse con semi diversi, identiche con lo stesso seme');

// Legacy: a state without the flag replays with the original (unshuffled) order.
const legacySeed = seed('5b');
const fresh = await createAutoState({ decks: [deck, deck], names: ['A', 'B'], firstPlayer: 0, lp: [8000, 8000], seed: legacySeed, passivePlayer: 1 });
const { replayAutoStateForTest } = await import('../api/_yugioh-auto-core.js');
if (typeof replayAutoStateForTest === 'function') {
  const legacy = { ...fresh }; delete legacy.deckShuffle;
  const rebuilt = await replayAutoStateForTest(legacy);
  assert.notEqual(hand(rebuilt), hand(fresh), 'una partita vecchia (senza mescolamento) non cambia ordine dopo l’aggiornamento');
  console.log('PASS partite già in corso: ricostruite con l’ordine originale');
}
console.log('yugioh-auto-shuffle-smoke: OK');
