// Card motion (2026-11-18, stile B): which moves a public state change produces.
// Read-only diff of public projections; covered cards never expose a name/image.
import assert from 'node:assert/strict';
import { cardMoves } from '../js/games/yugioh/simulator-card-motion.js';

const zones = () => ({ deck: [], hand: [], monsters: [], extraMonsters: [], spells: [], field: [], graveyard: [], banished: [], extra: [] });
const hidden = n => Array.from({ length: n }, (_, i) => ({ id: `hidden-${i}`, hidden: true, cardName: 'Carta coperta' }));
const card = (id, extra = {}) => ({ id, code: Number(id.replace(/\D/g, '')) || 7, cardName: 'Carta ' + id, imageUrl: `https://images.ygoprodeck.com/images/cards/${id}.jpg`, faceUp: true, ...extra });
const state = (p0 = {}, p1 = {}) => ({ players: [{ ...zones(), ...p0 }, { ...zones(), ...p1 }] });
const kinds = moves => moves.map(move => `${move.player}:${move.kind}:${move.from.zone}>${move.to.zone}`);

// Manual table: own cards keep their id.
let before = state({ deck: hidden(3), hand: [card('a1'), card('a2')] }), after = state({ deck: hidden(2), hand: [card('a1'), card('a2'), card('a3')] });
assert.deepEqual(kinds(cardMoves(before, after)), ['0:draw:deck>hand'], 'pescata');
before = state({ hand: [card('a1'), card('a2')] }); after = state({ hand: [card('a2')], monsters: [card('a1', { slot: 2 })] });
let moves = cardMoves(before, after); assert.deepEqual(kinds(moves), ['0:summon:hand>monsters']); assert.equal(moves[0].to.slot, 2);
after = state({ hand: [card('a2')], spells: [card('a1', { slot: 0, faceUp: false })] });
assert.deepEqual(kinds(cardMoves(before, after)), ['0:set:hand>spells'], 'Magia/Trappola posizionata');
after = state({ hand: [card('a2')], spells: [card('a1', { slot: 0 })] });
assert.deepEqual(kinds(cardMoves(before, after)), ['0:activate:hand>spells'], 'Magia attivata dalla mano');
before = state({ monsters: [card('m5', { slot: 1 })] });
assert.deepEqual(kinds(cardMoves(before, state({ graveyard: [card('m5')] }))), ['0:destroy:monsters>graveyard']);
assert.deepEqual(kinds(cardMoves(before, state({ banished: [card('m5')] }))), ['0:banish:monsters>banished']);
assert.deepEqual(kinds(cardMoves(before, state({ hand: [card('m5')] }))), ['0:bounce:monsters>hand']);
assert.deepEqual(kinds(cardMoves(state({ deck: hidden(3) }), state({ deck: hidden(2), graveyard: [card('g9')] }))), ['0:mill:deck>graveyard'], 'dal Deck al Cimitero');
assert.deepEqual(kinds(cardMoves(state({ hand: [card('d1')] }), state({ graveyard: [card('d1')] }))), ['0:discard:hand>graveyard']);
console.log('PASS tavolo manuale: pescata, evocazione, posizionata, attivata, distrutta, bandita, in mano, dal Deck al Cimitero, scartata');

// Opponent's view: hidden hand → face-down set (back only) and a covered trap flipped in place.
before = state({}, { hand: hidden(3) }); after = state({}, { hand: hidden(2), spells: [{ id: 'hidden-s', hidden: true, slot: 3 }] });
moves = cardMoves(before, after); assert.deepEqual(kinds(moves), ['1:set:hand>spells']);
assert(!moves[0].card.imageUrl && moves[0].card.hidden, 'la carta coperta vola come dorso, senza immagine');
before = state({}, { spells: [{ id: 'hidden-s', hidden: true, slot: 3 }] }); after = state({}, { spells: [card('t44', { slot: 3 })] });
assert.deepEqual(kinds(cardMoves(before, after)), ['1:activate-flip:spells>spells'], 'Trappola girata nella stessa casella');
before = state({}, { hand: hidden(2) }); after = state({}, { hand: hidden(1), monsters: [card('x12', { slot: 0 })] });
assert.deepEqual(kinds(cardMoves(before, after)), ['1:summon:hand>monsters'], 'evocazione dalla mano avversaria coperta');
console.log('PASS vista avversaria: le coperte restano dorsi; Trappola girata; evocazione dalla mano coperta');

// Automatic table: ids depend on position, identity is the card code.
before = state({ hand: [{ id: 'p0-2-0', code: 111, faceUp: true, cardName: 'A' }, { id: 'p0-2-1', code: 222, faceUp: true, cardName: 'B' }] });
after = state({ hand: [{ id: 'p0-2-0', code: 222, faceUp: true, cardName: 'B' }], monsters: [{ id: 'p0-4-0', code: 111, faceUp: true, slot: 0, cardName: 'A' }] });
moves = cardMoves(before, after, { mode: 'auto' }); assert.deepEqual(kinds(moves), ['0:summon:hand>monsters']); assert.equal(moves[0].card.code, 111);
assert.deepEqual(cardMoves(after, after, { mode: 'auto' }), [], 'stato invariato: nessun movimento');
console.log('PASS tavolo automatico: identità per codice, nessun falso movimento');
console.log('yugioh-card-motion-smoke: OK');
