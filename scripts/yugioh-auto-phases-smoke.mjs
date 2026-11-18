// Manual table, automatic phases (2026-11-18): at the start of a turn the
// draw, Standby and Main Phase 1 run by themselves, pausing only where a card
// could be activated — judged on PUBLIC information only.
import assert from 'node:assert/strict';
import { createSession, applyAction } from '../js/games/yugioh/simulator-engine.js';
import { phaseStopReasons } from '../js/games/yugioh/simulator-turn-rules.js';

const monster = i => ({ catalogCardId: String(20000000 + i), cardName: `Mostro ${i}`, type: 'Normal Monster', level: 4, section: 'main', quantity: 3, atk: 1500, def: 1000 });
const cards = Array.from({ length: 13 }, (_, i) => monster(i));
cards.push({ catalogCardId: '30000001', cardName: 'Trappola di prova', type: 'Trap Card', race: 'Normal', section: 'main', quantity: 1, text: 'Activate when your opponent declares an attack.' });
const deck = { game: 'yugioh', name: 'Prova', cards };
const act = (state, type, extra = {}) => applyAction(state, { type, player: state.activePlayer, ...extra });
const last = state => state.log.at(-1).text;

// Turn 1: no draw, straight to Main Phase 1.
let state = act(createSession({ decks: [deck, deck], names: ['Daniele', 'Nello'] }), 'start');
assert.equal(state.phase, 'main1');
assert.equal(state.turnState.autoPhases, true);
assert.match(last(state), /Main Phase 1/);
// Turn 2: automatic draw for the new active player, then Main Phase 1.
const handBefore = state.players[1].hand.length, top = state.players[1].deck[0].id;
state = act(state, 'nextTurn');
assert.equal(state.activePlayer, 1); assert.equal(state.phase, 'main1');
assert.equal(state.players[1].hand.length, handBefore + 1);
assert.equal(state.players[1].hand.at(-1).id, top, 'pesca la carta in cima al mazzo');
assert.equal(state.turnState.drawn, true);
assert.match(last(state), /Nello pesca 1 carta\. Draw e Standby Phase superate/);
assert.throws(() => act(state, 'draw'), /una volta per turno/, 'niente seconda pescata');
console.log('PASS turno senza carte attivabili: pescata automatica, Draw e Standby saltate, Main Phase 1');

// A face-down card in the Spell & Trap Zone pauses the Draw Phase (for both
// sides, whatever the card really is: its type is not public).
const trap = state.players[1].hand.find(card => /Trap/.test(card.type)) || state.players[1].deck.find(card => /Trap/.test(card.type));
const zone = state.players[1].hand.includes(trap) ? 'hand' : 'deck';
state = act(state, 'move', { cardId: trap.id, to: 'spells', slot: 0, faceUp: false });
assert.equal(state.players[1].spells.length, 1, `coperta da ${zone}`);
state = act(state, 'nextTurn');
assert.equal(state.activePlayer, 0); assert.equal(state.phase, 'draw', 'pausa in Draw Phase');
assert.equal(state.turnState.drawn, true, 'la pescata è già avvenuta');
assert.match(last(state), /Pausa in Draw Phase: si può attivare una carta \(Nello: 1 carta coperta\)/);
assert(!/Trappola/.test(last(state)), 'il registro non rivela la carta coperta');
// The active player continues: Standby has nothing to activate → Main Phase 1.
state = act(state, 'nextPhase');
assert.equal(state.phase, 'main1');
assert.match(last(state), /Standby Phase superata/);
console.log('PASS carta coperta: pausa in Draw Phase senza rivelarla; "Fase successiva" salta la Standby vuota');

// A face-up card whose text cites the Standby Phase pauses there.
const standbyCard = { ...state.players[0].hand[0], text: 'Once per turn, during your Standby Phase: gain 500 LP.' };
state.players[0].hand[0] = standbyCard;
state = act(state, 'move', { cardId: standbyCard.id, to: 'monsters', slot: 0, faceUp: true, position: 'attack' });
assert.deepEqual(phaseStopReasons(state, 'standby').map(reason => reason.cardName), [standbyCard.cardName]);
// Remove the set card so only the Standby cue remains.
state = act(state, 'nextTurn');
assert.equal(state.phase, 'draw', 'turno di Nello: in pausa per la sua carta coperta');
state = applyAction(state, { type: 'move', player: 1, cardId: trap.id, to: 'graveyard' });
while (['draw', 'standby'].includes(state.phase)) state = act(state, 'nextPhase');
while (state.players[1].hand.length > 6) state = act(state, 'move', { cardId: state.players[1].hand[0].id, to: 'graveyard' });
state = act(state, 'nextTurn');
assert.equal(state.activePlayer, 0); assert.equal(state.phase, 'standby', 'pausa in Standby Phase');
assert.match(last(state), new RegExp(`Pausa in Standby Phase: si può attivare una carta \\(${standbyCard.cardName} \\(Daniele\\)\\)`));
state = act(state, 'nextPhase'); assert.equal(state.phase, 'main1');
console.log('PASS carta scoperta che cita la Standby Phase: pausa lì, poi Main Phase 1');

// Quick Effects on the field pause the Draw Phase.
assert.equal(phaseStopReasons({ players: [{ monsters: [{ faceUp: true, cardName: 'Rapido', text: 'You can target 1 card (Quick Effect).' }] }, {}] }, 'draw').length, 1);
assert.equal(phaseStopReasons({ players: [{ monsters: [{ faceUp: false, cardName: 'Coperto', text: 'Quick Effect' }] }, {}] }, 'draw').length, 0, 'un mostro coperto non conta');
console.log('PASS Effetto Rapido scoperto: pausa in Draw Phase; mostri coperti ignorati');

// Empty deck: no automatic draw, the table stays in the Draw Phase.
let empty = act(createSession({ decks: [deck, deck], names: ['A', 'B'] }), 'start');
empty.players[1].banished.push(...empty.players[1].deck.splice(0).map(card => ({ ...card, faceUp: true })));
empty = act(empty, 'nextTurn');
assert.equal(empty.phase, 'draw'); assert.equal(empty.turnState.drawn, false);
assert.match(last(empty), /mazzo è vuoto/);
console.log('PASS mazzo vuoto: nessuna pescata automatica, resta in Draw Phase');

// Tables created before the change (no autoPhases) keep the manual steps.
let legacy = act(createSession({ decks: [deck, deck], autoPhases: false }), 'start');
assert.equal(legacy.phase, 'draw'); assert.equal(legacy.turnState.autoPhases, undefined);
legacy = act(act(legacy, 'nextPhase'), 'nextPhase'); legacy = act(legacy, 'nextTurn');
assert.equal(legacy.phase, 'draw'); assert.equal(legacy.turnState.drawn, false, 'i tavoli vecchi pescano a mano');
console.log('PASS tavoli già in corso: passaggi manuali invariati');
console.log('yugioh-auto-phases-smoke: OK');
