import assert from 'node:assert/strict';
import { createSession, applyAction, validateSimulatorDeck, validateSession, zoneSlots, canMoveCardToZone, PHASES, ZONES } from '../js/games/yugioh/simulator-engine.js';

const copy = value => JSON.parse(JSON.stringify(value));
const fixture = suffix => ({ id:`deck-${suffix}`, name:`Synthetic ${suffix}`, game:'yugioh', cards:[
  ...Array.from({ length:14 }, (_, i) => ({ catalogCardId:`monster-${i}`, cardName:`Monster ${i}`, section:'main', quantity:i === 13 ? 1 : 3, type:'Effect Monster', atk:1500, def:1000 })),
  { catalogCardId:'fusion-1', cardName:'Fusion', section:'extra', quantity:1, type:'Fusion Monster', atk:2500, def:2000 },
  { catalogCardId:'xyz-1', cardName:'Xyz', section:'extra', quantity:1, type:'XYZ Monster', atk:2400, def:1800 },
  { catalogCardId:'link-1', cardName:'Link', section:'extra', quantity:1, type:'Link Monster', atk:2300 },
  { catalogCardId:'side-1', cardName:'Side spell', section:'side', quantity:1, type:'Spell Card' }
] });
const decks = [fixture('A'), fixture('B')];
const fresh = () => createSession({ decks, firstPlayer:0, names:['Alice', 'Bob'] });
const started = () => applyAction(fresh(), { type:'start' });
const act = (state, type, options = {}) => applyAction(state, { type, player:0, ...options });
const integrity = state => assert.deepEqual(validateSession(state), { valid:true, errors:[] });
const play = (state, index = 0, slot) => act(state, 'move', { cardId:state.players[0].hand[index].id, to:'monsters', ...(slot === undefined ? {} : { slot }) });

assert.equal(validateSimulatorDeck(decks[0]).valid, true);
for (const quantity of [0, -1, 1.1, '3', 4]) {
  const deck = copy(decks[0]); deck.cards[0].quantity = quantity;
  assert.equal(validateSimulatorDeck(deck).valid, false);
}
assert.equal(validateSimulatorDeck({ ...decks[0], game:'onepiece' }).valid, false);
const duplicate = copy(decks[0]); duplicate.cards.push({ ...duplicate.cards[0], section:'side', quantity:1 });
assert.equal(validateSimulatorDeck(duplicate).valid, false, 'Copy limits combine all sections');
const invalidExtra = copy(decks[0]); invalidExtra.cards[14].type = 'Effect Monster';
assert.equal(validateSimulatorDeck(invalidExtra).valid, false, 'A main-deck Monster is not an Extra Deck card');
for (const input of [{ decks:[decks[0]] }, { decks, firstPlayer:2 }, { decks, lp:[0, 8000] }]) assert.throws(() => createSession(input));

let state = fresh();
assert.equal(state.phase, 'setup');
assert.equal(state.players[0].hand.length, 5);
assert.equal(state.players[0].deck.length, 35);
assert.equal(state.players[0].extra.length, 3);
assert.equal(state.players[0].side.length, 1);
assert.throws(() => act(state, 'draw'), /pronti/);
state = act(state, 'start');
assert.equal(state.phase, 'draw');
assert.equal(state.players[0].hand.length, 5, 'Starting never performs the first draw');
assert.throws(() => act(state, 'mulligan'), /non disponibile/);

const beforeDraw = copy(state);
state = act(state, 'draw');
assert.deepEqual(beforeDraw.players[0].hand.length, 5);
assert.equal(state.players[0].hand.length, 6);
assert.throws(() => act(state, 'draw', { count:60 }), /abbastanza/);
state = play(state, 0, 4);
const firstId = state.players[0].monsters[0].id;
state = play(state, 0, 0);
const secondId = state.players[0].monsters[1].id;
const occupied = copy(state);
assert.throws(() => act(state, 'move', { cardId:firstId, to:'extraMonsters', slot:0 }), /zona scelta/, 'Main-deck Normal Monsters cannot occupy Extra Monster Zones');
assert.throws(() => act(state, 'move', { cardId:secondId, to:'monsters', slot:4 }), /occupata/);
assert.deepEqual(state, occupied, 'Rejected moves leave the complete original state intact');
const hiddenBanished = act(state, 'move', { cardId:state.players[0].hand[0].id, to:'banished', faceUp:false });
assert(!hiddenBanished.log.at(-1).text.includes(hiddenBanished.players[0].banished[0].cardName), 'Face-down banishment must not leak the hidden card name');
state = act(state, 'move', { cardId:secondId, to:'graveyard' });
assert.equal(zoneSlots(state.players[0], 'monsters')[4].id, firstId, 'KO never compacts positions');
assert.equal(zoneSlots(state.players[0], 'monsters')[0], null);
state = act(state, 'setPosition', { cardId:firstId, position:'defense', faceUp:false });
assert.equal(state.players[0].monsters[0].faceUp, false);
assert(!state.log.at(-1).text.includes(state.players[0].monsters[0].cardName), 'Covered changes cannot leak names into shared logs');
state = act(state, 'flip', { cardId:firstId });
assert.equal(state.players[0].monsters[0].faceUp, true);
state = act(state, 'setPosition', { cardId:firstId, position:'attack' });
state = act(state, 'stats', { cardId:firstId, stat:'atk', delta:500 });
state = act(state, 'counter', { cardId:firstId, delta:2 });
assert.equal(state.players[0].monsters[0].atkModifier, 500);
assert.equal(state.players[0].monsters[0].counters, 2);
assert.throws(() => act(state, 'counter', { cardId:firstId, delta:-3 }), /segnalini/);
assert.throws(() => act(state, 'stats', { cardId:state.players[0].hand[0].id, stat:'atk', delta:500 }), /non presente/);
state = act(state, 'lp', { delta:-1500 });
assert.equal(state.players[0].lp, 6500);
assert.throws(() => act(state, 'lp', { delta:-7000 }), /Life Points/);

// Global Extra Monster slots are shared physical positions, never per-player copies.
const fusion = state.players[0].extra.find(card => /Fusion/.test(card.type));
state = act(state, 'move', { cardId:fusion.id, to:'extraMonsters', slot:0 });
const opponentFusion = state.players[1].extra.find(card => /Fusion/.test(card.type));
assert.throws(() => act(state, 'move', { player:1, cardId:opponentFusion.id, to:'extraMonsters', slot:0 }), /occupata/);
state = act(state, 'move', { player:1, cardId:opponentFusion.id, to:'extraMonsters', slot:1 });
state = act(state, 'move', { cardId:fusion.id, to:'hand' });
assert(state.players[0].extra.some(card => card.id === fusion.id && !card.faceUp), 'Fusion returned to hand goes into Extra Deck face-down');
assert(!state.players[0].hand.some(card => card.id === fusion.id));
const link = state.players[0].extra.find(card => /Link/.test(card.type));
assert.throws(() => act(state, 'move', { cardId:link.id, to:'monsters', position:'defense' }), /Posizione/);
state = act(state, 'move', { cardId:link.id, to:'monsters', slot:1 });
assert.throws(() => act(state, 'flip', { cardId:link.id }), /Orientamento/);

const xyz = state.players[0].extra.find(card => /XYZ/.test(card.type));
state = act(state, 'move', { cardId:xyz.id, to:'monsters', slot:2 });
state = act(state, 'attachMaterial', { cardId:firstId, targetId:xyz.id });
assert.equal(state.players[0].monsters.find(card => card.id === xyz.id).materials[0].id, firstId);
assert.equal(state.players[0].monsters.find(card => card.id === xyz.id).materials[0].slot, null);
state = act(state, 'detachMaterial', { cardId:xyz.id, index:0 });
assert(state.players[0].graveyard.some(card => card.id === firstId));
state = act(state, 'attachMaterial', { cardId:firstId, targetId:xyz.id });
state = act(state, 'move', { cardId:xyz.id, to:'graveyard' });
assert(state.players[0].graveyard.some(card => card.id === firstId), 'Materials go to GY when the Xyz leaves the field');
assert.equal(state.players[0].graveyard.find(card => card.id === xyz.id).materials.length, 0);

state = act(state, 'token', { slot:0, atk:500, def:500 });
const token = state.players[0].monsters.find(card => card.token);
assert(token?.faceUp);
assert.throws(() => act(state, 'setPosition', { cardId:token.id, position:'defense', faceUp:false }), /Orientamento/);
state = act(state, 'move', { cardId:token.id, to:'banished' });
assert(!ZONES.some(zone => state.players[0][zone].some(card => card.id === token.id)), 'Tokens disappear when leaving the field');

// Main-deck Pendulum: field → GY becomes face-up Extra, materials → GY stays GY.
let pendulum = started();
pendulum.players[0].hand[0].type = 'Pendulum Effect Monster';
const pendulumId = pendulum.players[0].hand[0].id;
pendulum = play(pendulum, 0, 0);
pendulum = act(pendulum, 'move', { cardId:pendulumId, to:'graveyard' });
assert(pendulum.players[0].extra.some(card => card.id === pendulumId && card.faceUp));
pendulum = act(pendulum, 'move', { cardId:pendulumId, to:'hand' });
assert(pendulum.players[0].hand.some(card => card.id === pendulumId && !card.faceUp));

const castState = copy(state);
castState.players[0].hand[0].type = 'Spell Card';
const spellId = castState.players[0].hand[0].id;
assert.equal(canMoveCardToZone(castState.players[0].hand[0], 'monsters'), false);
let spell = act(castState, 'move', { cardId:spellId, to:'spells', slot:0, faceUp:false });
assert(!spell.log.at(-1).text.includes(spell.players[0].spells[0].cardName), 'Setting a card keeps its name out of the shared log');
spell = act(spell, 'activate', { cardId:spellId });
assert.equal(spell.players[0].spells[0].faceUp, true);
assert.equal(spell.chain.length, 1);
spell = act(spell, 'activate', { cardId:link.id });
spell = act(spell, 'resolveChain');
assert.equal(spell.chain.length, 1, 'Chain resolution follows last-in-first-out');
spell = act(spell, 'resolveChain');
assert.equal(spell.chain.length, 0);
assert.throws(() => act(spell, 'resolveChain'), /anelli/);
spell = act(spell, 'move', { cardId:spellId, to:'graveyard' });
assert.equal(spell.players[0].graveyard.find(card => card.id === spellId).faceUp, true);

const order = state.players[0].deck.map(card => card.id).sort();
state = act(state, 'shuffle');
assert.deepEqual(state.players[0].deck.map(card => card.id).sort(), order);
for (const phase of PHASES.slice(1)) { state = act(state, 'nextPhase'); assert.equal(state.phase, phase); }
state = act(state, 'nextPhase');
assert.equal(state.activePlayer, 1); assert.equal(state.phase, 'draw'); assert.equal(state.turn, 2);
assert.throws(() => act(state, 'nextPhase'), /attivo/);
state = act(state, 'nextTurn', { player:1 });
assert.equal(state.activePlayer, 0); assert.equal(state.turn, 3);
integrity(state); integrity(spell); integrity(pendulum);
const damaged = copy(state); damaged.players[0].hand.push(damaged.players[0].hand[0]);
assert.equal(validateSession(damaged).valid, false);
const wrongOwner = copy(state); wrongOwner.players[0].hand[0].id = 'p1-main-0';
assert.equal(validateSession(wrongOwner).valid, false);
state = act(state, 'finish', { winner:0, notes:'Synthetic duel completed.' });
assert.equal(state.result.winner, 0);
assert.throws(() => act(state, 'draw'), /concluso/);
integrity(state);
console.log('yugioh-simulator-engine-smoke: OK (private-safe logs, fixed/shared zones, LP, positions, materials, tokens, Pendulum, chains, turns and card conservation)');
