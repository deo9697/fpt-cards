// Unit smoke for js/games/yugioh/simulator-fx-events.js: which visual effects a
// state update produces (turn, phase, newly summoned monsters). Read-only diff.
import assert from 'node:assert/strict';
import { duelFxEvents, summonTypeOf } from '../js/games/yugioh/simulator-fx-events.js';

const card = (id, extra = {}) => ({ id, cardName: 'Carta ' + id, imageUrl: 'https://images.ygoprodeck.com/images/cards/' + id + '.jpg', type: 'Effect Monster', faceUp: true, materials: [], ...extra });
const player = (name, zones = {}) => ({ name, hand: [], monsters: [], extraMonsters: [], spells: [], ...zones });
const state = (over = {}) => ({ turn: 3, phase: 'main1', activePlayer: 0, players: [player('Daniele'), player('Nello')], ...over });

assert.deepEqual(duelFxEvents(null, state(), 0), [], 'prima apertura del tavolo: nessun effetto');
assert.deepEqual(duelFxEvents(state(), state(), 0), [], 'stato invariato: nessun effetto');

let events = duelFxEvents(state({ phase: 'main1' }), state({ phase: 'battle' }), 0);
assert.deepEqual(events, [{ kind: 'phase', name: 'battle', turn: 3, player: 'Daniele' }]);
events = duelFxEvents(state({ turn: 3, phase: 'end', activePlayer: 0 }), state({ turn: 4, phase: 'draw', activePlayer: 1 }), 0);
assert.deepEqual(events.map(e => e.name), ['opponent-turn', 'draw'], 'nuovo turno avversario poi fase Draw');
events = duelFxEvents(state({ turn: 4, activePlayer: 1, phase: 'end' }), state({ turn: 5, activePlayer: 0, phase: 'draw' }), 0);
assert.equal(events[0].name, 'your-turn');
console.log('PASS turni e fasi: "Il tuo turno" / "Turno avversario" e fascia della fase nuova');

// Normal Summon from hand vs Special from elsewhere vs Extra Deck types.
const before = state({ players: [player('Daniele', { hand: [card('1')] }), player('Nello')] });
events = duelFxEvents(before, state({ players: [player('Daniele', { monsters: [card('1')] }), player('Nello')] }), 0);
assert.equal(events.length, 1); assert.equal(events[0].type, 'normal'); assert.equal(events[0].name, 'Carta 1');
events = duelFxEvents(state(), state({ players: [player('Daniele', { monsters: [card('2')] }), player('Nello')] }), 0);
assert.equal(events[0].type, 'special', 'dal Cimitero/mazzo: Evocazione Speciale');
const extra = [['Synchro Monster', 'synchro'], ['XYZ Monster', 'xyz'], ['Link Monster', 'link'], ['Fusion Monster', 'fusion'], ['Ritual Effect Monster', 'ritual']];
for (const [type, expected] of extra) assert.equal(summonTypeOf({ type, faceUp: true }, false), expected, type);
events = duelFxEvents(state(), state({ players: [player('Daniele', { extraMonsters: [card('9', { type: 'XYZ Monster', rank: 4, level: null, materials: [card('a'), card('b')] })] }), player('Nello')] }), 0);
assert.deepEqual({ type: events[0].type, rank: events[0].rank, materials: events[0].materials }, { type: 'xyz', rank: 4, materials: 2 });
console.log('PASS evocazioni: Normale dalla mano, Speciale da altrove, Synchro/Xyz/Link/Fusione/Rituale dal tipo, rango e materiali Xyz');

// Face-down: no artwork, no name leak (also for the opponent's set cards).
events = duelFxEvents(state(), state({ players: [player('Daniele'), player('Nello', { monsters: [card('7', { faceUp: false })] })] }), 0);
assert.deepEqual({ type: events[0].type, image: events[0].image, name: events[0].name }, { type: 'set', image: '', name: 'Carta coperta' }, 'carta coperta: nessuna immagine né nome');
// A monster that only moves between Monster Zones is not a new summon.
events = duelFxEvents(state({ players: [player('Daniele', { monsters: [card('3')] }), player('Nello')] }), state({ players: [player('Daniele', { extraMonsters: [card('3')] }), player('Nello')] }), 0);
assert.deepEqual(events, [], 'spostamento tra zone mostri: nessuna evocazione');
// At most two summon effects per update.
events = duelFxEvents(state(), state({ players: [player('Daniele', { monsters: [card('4'), card('5'), card('6')] }), player('Nello')] }), 0);
assert.equal(events.length, 2, 'al massimo 2 evocazioni per aggiornamento');
console.log('PASS coperte senza immagine né nome, spostamenti ignorati, massimo 2 evocazioni per aggiornamento');
console.log('yugioh-fx-events-smoke: OK');
