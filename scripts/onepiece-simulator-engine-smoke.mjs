import assert from 'node:assert/strict';
import { createSession, applyAction, characterSlots, validateSimulatorDeck, validateSession, PHASES, ZONES } from '../js/games/onepiece/simulator-engine.js';

const fixture = suffix => ({
  id: `deck-${suffix}`, name: `Test ${suffix}`, game: 'onepiece',
  cards: [
    { catalogCardId: 'OP01-001', cardName: 'Leader', section: 'leader', quantity: 1, colors: ['Red'], power: 5000 },
    ...Array.from({ length: 12 }, (_, index) => ({ catalogCardId: `OP01-${String(index + 2).padStart(3, '0')}`, cardName: `Personaggio ${index}`, section: 'main', quantity: 4, colors: ['Red'], power: 3000 })),
    { catalogCardId: 'OP01-014', cardName: 'Carta senza tipo', section: 'main', quantity: 2, colors: ['Red'] }
  ]
});
const deckA = fixture('a'), deckB = fixture('b');
const fresh = () => createSession({ decks: [deckA, deckB], names: ['A', 'B'], life: [4, 5], firstPlayer: 1 });
const started = () => applyAction(fresh(), { type: 'start' });
const act = (session, type, options = {}) => applyAction(session, { type, player: 0, ...options });
const clone = value => JSON.parse(JSON.stringify(value));
const integrity = session => {
  assert.deepEqual(validateSession(session), { valid: true, errors: [] });
  for (const player of session.players) {
    assert.equal(ZONES.reduce((sum, zone) => sum + player[zone].length, 0), 50);
    assert.equal(player.don.deck + player.don.active + player.don.rested + player.leader.don + player.characters.reduce((sum, card) => sum + card.don, 0), 10);
  }
};

assert.equal(validateSimulatorDeck(deckA).valid, true, 'DON!! absent from catalog is supported');
const variants = clone(deckA);
variants.cards[1].quantity = 2;
variants.cards.push({ ...variants.cards[1], quantity: 2, printingId: 'parallel' });
assert.equal(validateSimulatorDeck(variants).valid, true, 'copies aggregate across printing rows');
variants.cards[1].quantity = 3;
variants.cards[2].quantity = 3;
assert.equal(validateSimulatorDeck(variants).valid, false, 'five logical copies across printing variants rejected');
for (const quantity of [0, -1, 1.5, '4', NaN, Infinity]) {
  const invalid = clone(deckA); invalid.cards[1].quantity = quantity;
  assert.equal(validateSimulatorDeck(invalid).valid, false, `reject malformed quantity ${quantity}`);
}
const wrongGame = { ...deckA, game: 'yugioh' };
assert.throws(() => createSession({ decks: [deckA, wrongGame] }), /One Piece/);
assert.throws(() => createSession({ decks: [deckA, deckB], life: [0, 5] }), /Life/);
assert.throws(() => createSession({ decks: [deckA, deckB], firstPlayer: 2 }), /iniziale/);
const wrongColors = clone(deckA); wrongColors.cards[1].colors = ['Blue'];
assert.equal(validateSimulatorDeck(wrongColors).valid, false);

// The advanced move form must respect known card types just like tap-to-play.
// Legacy cards without metadata remain movable so existing tables still load.
for (const type of ['Stage', 'stage', 'Event', 'EVENT', 'Evento', 'Leader']) {
  let typed = started();
  const card = typed.players[0].hand[0]; card.type = type;
  const before = clone(typed);
  assert.throws(() => act(typed, 'move', { cardId: card.id, to: 'characters' }), /soltanto carte Personaggio/);
  assert.deepEqual(typed, before, `${type}: illegal Character play preserves the original state`);
  typed = act(typed, 'move', { cardId: card.id, to: 'trash' });
  assert.equal(typed.players[0].trash.at(-1).id, card.id, `${type}: manual disposal remains available`);
}
for (const type of ['Character', 'CHARACTER', 'Personaggio', 'Event', 'evento', 'Leader']) {
  const typed = started(), card = typed.players[0].hand[0]; card.type = type;
  const before = clone(typed);
  assert.throws(() => act(typed, 'move', { cardId: card.id, to: 'stage' }), /soltanto carte Stage/);
  assert.deepEqual(typed, before, `${type}: illegal Stage play preserves the original state`);
}
for (const [type, to] of [['Character', 'characters'], ['Personaggio', 'characters'], ['Stage', 'stage'], ['', 'characters'], ['', 'stage']]) {
  let typed = started(); const id = typed.players[0].hand[0].id;
  typed.players[0].hand[0].type = type;
  typed = act(typed, 'move', { cardId: id, to });
  assert.equal(typed.players[0][to][0].id, id, `${type || 'legacy unknown'} can enter ${to}`);
  integrity(typed);
}
for (const zone of ['hand', 'deck', 'life', 'trash']) {
  let offBoard = started();
  const id = offBoard.players[0].hand[0].id;
  offBoard = act(offBoard, 'move', { cardId: id, to: zone });
  const before = clone(offBoard);
  for (const command of ['toggleRest', 'attachDon', 'detachDon', 'power']) {
    assert.throws(() => act(offBoard, command, { cardId: id, delta: 1000 }), /non presente/);
    assert.deepEqual(offBoard, before, `${command}: ${zone} cannot be activated or modified as a board card`);
  }
}

let session = fresh();
const original = clone(session);
assert.equal(session.phase, 'setup');
assert.equal(session.activePlayer, 1);
assert.equal(session.players[0].hand.length, 5);
assert.equal(session.players[0].deck.length, 45);
assert.equal(session.players[0].life.length, 0, 'Life not dealt before mulligan');
assert.ok(session.players.every(player => [player.leader, ...ZONES.flatMap(zone => player[zone])].every(card => card.slot === null)), 'cards begin without a Character position');
assert.equal(new Set(session.players.flatMap(player => [player.leader, ...ZONES.flatMap(zone => player[zone])]).map(card => card.id)).size, 102);
assert.throws(() => act(session, 'draw'), /preparazione/);
session = act(session, 'mulligan');
assert.deepEqual(original, { ...original }, 'source fixture remains stable');
assert.equal(original.players[0].mulliganUsed, false, 'mulligan never mutates original session');
assert.equal(session.players[0].mulliganUsed, true);
assert.equal(session.players[0].hand.length, 5);
assert.equal(session.players[0].deck.length, 45);
assert.equal(session.players[0].life.length, 0);
assert.throws(() => act(session, 'mulligan'), /sola volta/);
const expectedLife = session.players.map(player => player.deck.slice(0, player.lifeCount).map(card => card.id).reverse());
session = act(session, 'start');
assert.equal(session.phase, 'refresh');
assert.deepEqual(session.players.map(player => player.life.map(card => card.id)), expectedLife, 'top deck becomes bottom Life');
assert.equal(session.players[0].deck.length, 41);
assert.throws(() => act(session, 'mulligan'), /sola volta/);
assert.throws(() => act(session, 'start'), /già iniziata/);
integrity(session);

// Logs must not reveal cards transferred between hidden zones.
let hiddenSession = started();
const hiddenLife = hiddenSession.players[0].life[0];
hiddenSession = act(hiddenSession, 'move', { cardId: hiddenLife.id, to: 'hand' });
assert.equal(hiddenSession.log.at(-1).text.includes(hiddenLife.cardName), false, 'covered Life to covered hand is anonymous in the log');
assert.ok(hiddenSession.log.at(-1).text.includes('una carta'));
hiddenSession = act(hiddenSession, 'move', { cardId: hiddenLife.id, to: 'deck' });
assert.equal(hiddenSession.log.at(-1).text.includes(hiddenLife.cardName), false, 'hand to deck is anonymous in the log');
hiddenSession = act(hiddenSession, 'move', { cardId: hiddenLife.id, to: 'life' });
assert.equal(hiddenSession.log.at(-1).text.includes(hiddenLife.cardName), false, 'deck to Life is anonymous in the log');
hiddenSession = act(hiddenSession, 'toggleFaceUp', { cardId: hiddenLife.id });
hiddenSession = act(hiddenSession, 'move', { cardId: hiddenLife.id, to: 'hand' });
assert.equal(hiddenSession.log.at(-1).text.includes(hiddenLife.cardName), true, 'face-up Life identity is public before resetting in hand');
hiddenSession = act(hiddenSession, 'move', { cardId: hiddenLife.id, to: 'characters' });
assert.equal(hiddenSession.log.at(-1).text.includes(hiddenLife.cardName), true, 'moving onto public field records card identity');
hiddenSession = act(hiddenSession, 'move', { cardId: hiddenLife.id, to: 'trash' });
assert.equal(hiddenSession.log.at(-1).text.includes(hiddenLife.cardName), true, 'public field to trash records card identity');
hiddenSession = act(hiddenSession, 'move', { cardId: hiddenLife.id, to: 'hand' });
assert.equal(hiddenSession.log.at(-1).text.includes(hiddenLife.cardName), true, 'public trash to hand records the already known identity');
hiddenSession = act(hiddenSession, 'draw');
assert.equal(hiddenSession.log.at(-1).text, 'A: pesca 1 carta.');
hiddenSession = act(hiddenSession, 'shuffle', { zone: 'deck' });
assert.equal(hiddenSession.log.at(-1).text, 'A: mazzo mescolato.');
const mulliganLog = act(fresh(), 'mulligan').log.at(-1).text;
assert.equal(mulliganLog, 'A: mulligan completo, nuova mano di 5 carte.');

// Individual Life reveals are separate from peeking at hidden Life in the UI.
const lifeId = session.players[0].life[0].id;
assert.equal(session.players[0].life[0].faceUp, false);
session = act(session, 'toggleFaceUp', { cardId: lifeId });
assert.equal(session.players[0].life[0].faceUp, true);
session = act(session, 'toggleFaceUp', { cardId: lifeId });
assert.equal(session.players[0].life[0].faceUp, false);
session = act(session, 'toggleFaceUp', { cardId: lifeId });
session = act(session, 'move', { cardId: lifeId, to: 'hand' });
assert.equal(session.players[0].hand.at(-1).faceUp, false, 'revealed Life becomes hidden again on entering hand');
session = act(session, 'move', { cardId: lifeId, to: 'life' });
assert.equal(session.players[0].life[0].faceUp, false, 'Life placed face-down by default');
session = act(session, 'toggleFaceUp', { cardId: lifeId });
session = act(session, 'move', { cardId: lifeId, to: 'deck' });
assert.equal(session.players[0].deck[0].faceUp, false, 'revealed Life becomes hidden again on entering deck');
assert.throws(() => act(session, 'toggleFaceUp', { cardId: lifeId }), /zona Life/);
session = act(session, 'move', { cardId: lifeId, to: 'life' });
const legacyFace = clone(session);
for (const player of legacyFace.players) for (const card of [player.leader, ...ZONES.flatMap(zone => player[zone])]) delete card.faceUp;
assert.equal(validateSession(legacyFace).valid, true, 'earlier version-1 saves without faceUp remain readable');
assert.equal(act(legacyFace, 'toggleFaceUp', { cardId: lifeId }).players[0].life[0].faceUp, true);

const first = session.players[0].hand[0].id;
const beforeMove = clone(session);
session = act(session, 'move', { cardId: first, to: 'characters' });
assert.deepEqual(beforeMove.players[0].characters, [], 'moving card does not mutate source');
assert.equal(session.players[0].characters[0].id, first);
session = act(session, 'toggleRest', { cardId: first });
assert.equal(session.players[0].characters[0].rested, true);
session = act(session, 'power', { cardId: first, delta: 2000 });
assert.equal(session.players[0].characters[0].powerModifier, 2000);
session = act(session, 'addDon', { count: 5 });
session = act(session, 'attachDon', { cardId: first, count: 2 });
assert.equal(session.players[0].characters[0].don, 2);
assert.equal(session.players[0].don.active, 3);
session = act(session, 'restDon', { count: 2 });
session = act(session, 'activateDon');
session = act(session, 'detachDon', { cardId: first });
assert.deepEqual(session.players[0].don, { deck: 5, active: 2, rested: 2 });
session = act(session, 'returnDon', { source: first });
assert.equal(session.players[0].don.deck, 6);
session = act(session, 'attachDon', { cardId: first, count: 2 });
session = act(session, 'move', { cardId: first, to: 'trash' });
assert.deepEqual(session.players[0].don, { deck: 6, active: 0, rested: 4 }, 'attached DON return rested when card leaves area');
const trashed = session.players[0].trash[0];
assert.equal(trashed.don, 0);
assert.equal(trashed.rested, false);
assert.equal(trashed.powerModifier, 0, 'zone change clears temporary power');
session = act(session, 'returnDon', { source: 'rested', count: 2 });
session = act(session, 'activateDon', { count: 2 });
session = act(session, 'returnDon', { source: 'active', count: 2 });
assert.deepEqual(session.players[0].don, { deck: 10, active: 0, rested: 0 });
integrity(session);

session = act(session, 'addDon', { count: 10 });
session = act(session, 'attachDon', { cardId: session.players[0].leader.id, count: 2 });
const stageId = session.players[0].hand[0].id;
session = act(session, 'move', { cardId: stageId, to: 'stage' });
session = act(session, 'toggleRest', { cardId: stageId });
session = act(session, 'toggleRest', { cardId: session.players[0].leader.id });
session = act(session, 'restDon', { count: 3 });
session = act(session, 'refresh');
assert.equal(session.players[0].stage[0].rested, false, 'refresh readies Stage too');
assert.equal(session.players[0].leader.rested, false);
assert.equal(session.players[0].leader.don, 0);
assert.equal(session.players[0].don.active, 10);
assert.throws(() => act(session, 'attachDon', { cardId: stageId }), /soltanto/);
assert.throws(() => act(session, 'power', { cardId: stageId, delta: 1000 }), /Solo/);
assert.throws(() => act(session, 'move', { cardId: session.players[0].leader.id, to: 'trash' }), /Leader/);
assert.throws(() => act(session, 'move', { cardId: session.players[1].hand[0].id, to: 'trash' }), /non presente/);
assert.throws(() => act(session, 'move', { cardId: session.players[0].hand[0].id, to: 'stage' }), /Stage/);
for (const count of [-1, 0, 1.2, '1', 11, Infinity]) assert.throws(() => act(session, 'restDon', { count }), /quantità/);
assert.throws(() => act(session, 'returnDon', { source: 'rested' }), /abbastanza/);
assert.throws(() => act(session, 'draw', { count: 50 }), /abbastanza/);
assert.throws(() => act(session, 'addDon'), /abbastanza/);
integrity(session);

session = act(session, 'draw', { count: 3 });
const top = session.players[0].hand[0].id;
session = act(session, 'move', { cardId: top, to: 'deck', position: 'top' });
assert.equal(session.players[0].deck[0].id, top);
session = act(session, 'draw');
assert.equal(session.players[0].hand.at(-1).id, top);
session = act(session, 'move', { cardId: top, to: 'life', position: 'bottom' });
assert.equal(session.players[0].life.at(-1).id, top);
session = act(session, 'move', { cardId: top, to: 'hand' });
session = act(session, 'move', { cardId: top, to: 'deck', position: 'bottom' });
assert.equal(session.players[0].deck.at(-1).id, top);
const deckCards = session.players[0].deck.map(card => card.id).sort();
session = act(session, 'shuffle', { zone: 'deck' });
assert.deepEqual(session.players[0].deck.map(card => card.id).sort(), deckCards);
const lifeCards = session.players[0].life.map(card => card.id).sort();
session = act(session, 'shuffle', { zone: 'life' });
assert.deepEqual(session.players[0].life.map(card => card.id).sort(), lifeCards);
assert.throws(() => act(session, 'shuffle', { zone: 'hand' }), /mescolare/);
integrity(session);

// A five-position battlefield keeps holes and does not detach DON!! on a reposition.
let field = started();
const [rightId, middleId, leftId, refillId] = field.players[0].hand.map(card => card.id);
field = act(field, 'move', { cardId: rightId, to: 'characters', slot: 4 });
field = act(field, 'move', { cardId: middleId, to: 'characters', slot: 2 });
field = act(field, 'move', { cardId: leftId, to: 'characters' });
const slotIds = value => characterSlots(value.players[0]).map(card => card?.id ?? null);
assert.deepEqual(slotIds(field), [leftId, null, middleId, null, rightId], 'explicit slots are reserved and default play takes the first free one');
const occupiedBefore = clone(field);
assert.throws(() => act(field, 'move', { cardId: leftId, to: 'characters', slot: 2 }), /occupata/);
assert.throws(() => act(field, 'move', { cardId: refillId, to: 'characters', slot: 4 }), /occupata/);
assert.deepEqual(field, occupiedBefore, 'a rejected occupied-slot move never changes cards or positions');
for (const slot of [-1, 5, 1.2, '1', null, NaN, Infinity]) assert.throws(() => act(field, 'move', { cardId: refillId, to: 'characters', slot }), /posizione/);
assert.throws(() => act(field, 'move', { cardId: leftId, to: 'trash', slot: 0 }), /posizione/);
field = act(field, 'addDon', { count: 4 });
field = act(field, 'attachDon', { cardId: leftId, count: 2 });
field = act(field, 'toggleRest', { cardId: leftId });
field = act(field, 'power', { cardId: leftId, delta: 1500 });
const resourcesBeforeReposition = clone(field.players[0].don);
field = act(field, 'move', { cardId: leftId, to: 'characters', slot: 3 });
assert.deepEqual(slotIds(field), [null, null, middleId, leftId, rightId]);
assert.deepEqual(field.players[0].don, resourcesBeforeReposition, 'moving between Character positions never refunds DON!!');
assert.equal(characterSlots(field.players[0])[3].don, 2);
assert.equal(characterSlots(field.players[0])[3].rested, true);
assert.equal(characterSlots(field.players[0])[3].powerModifier, 1500);
field = act(field, 'move', { cardId: leftId, to: 'characters' });
assert.equal(characterSlots(field.players[0])[3].id, leftId, 'a Character move without a requested slot keeps its current position');
field = act(field, 'move', { cardId: middleId, to: 'trash' });
assert.deepEqual(slotIds(field), [null, null, null, leftId, rightId], 'KO leaves the other Characters in place');
assert.equal(field.players[0].trash.find(card => card.id === middleId).slot, null);
field = act(field, 'move', { cardId: refillId, to: 'characters' });
assert.deepEqual(slotIds(field), [refillId, null, null, leftId, rightId], 'the next default play fills the first empty position');
field = act(field, 'move', { cardId: leftId, to: 'trash' });
assert.deepEqual(slotIds(field), [refillId, null, null, null, rightId]);
assert.equal(field.players[0].trash.find(card => card.id === leftId).slot, null);
assert.equal(field.players[0].don.rested, 2, 'leaving the Character area still returns attached DON!! rested');
assert.deepEqual(slotIds(JSON.parse(JSON.stringify(field))), slotIds(field), 'position gaps survive a saved-session round trip');
integrity(field);

// Existing games load without migrating the save, then normalize only a cloned action state.
const legacySlots = clone(occupiedBefore);
for (const player of legacySlots.players) for (const card of [player.leader, ...ZONES.flatMap(zone => player[zone])]) delete card.slot;
const legacyBefore = clone(legacySlots);
assert.equal(validateSession(legacySlots).valid, true, 'earlier version-1 saves without slots remain valid');
assert.deepEqual(slotIds(legacySlots), [rightId, middleId, leftId, null, null], 'legacy Characters retain array order when first assigned positions');
assert.deepEqual(legacySlots, legacyBefore, 'reading legacy positions is pure');
const normalizedSlots = act(legacySlots, 'nextPhase');
assert.deepEqual(normalizedSlots.players[0].characters.map(card => card.slot), [0, 1, 2]);
assert.deepEqual(legacySlots, legacyBefore, 'normalizing an action never mutates the stored input');
const mixedSlots = clone(legacySlots);
mixedSlots.players[0].characters[1].slot = 0;
assert.deepEqual(slotIds(mixedSlots), [middleId, rightId, leftId, null, null], 'explicit slots take priority over legacy fallback positions');
assert.deepEqual(act(mixedSlots, 'nextPhase').players[0].characters.map(card => card.slot), [1, 0, 2]);
integrity(normalizedSlots);

// Full Character area requires an explicit discard, never silently loses a card.
while (session.players[0].characters.length < 5) session = act(session, 'move', { cardId: session.players[0].hand[0].id, to: 'characters' });
assert.deepEqual(characterSlots(session.players[0]).map(card => card.slot), [0, 1, 2, 3, 4]);
assert.throws(() => act(session, 'move', { cardId: session.players[0].deck[0].id, to: 'characters' }), /5 Personaggi/);

const manuallyUnchanged = session.players.map(player => ({ don: clone(player.don), hand: player.hand.length, leaderRest: player.leader.rested }));
for (const phase of PHASES.slice(1)) {
  session = act(session, 'nextPhase');
  assert.equal(session.phase, phase);
}
session = act(session, 'nextPhase');
assert.equal(session.turn, 2);
assert.equal(session.activePlayer, 0);
assert.equal(session.phase, 'refresh');
assert.deepEqual(session.players.map(player => ({ don: player.don, hand: player.hand.length, leaderRest: player.leader.rested })), manuallyUnchanged, 'phase and turn markers do not apply automated actions');
session = act(session, 'nextTurn');
assert.equal(session.turn, 3);
assert.equal(session.activePlayer, 1);
assert.equal(session.phase, 'refresh');

// Malformed saves are rejected before either resume or an action can mutate them.
for (const tamper of [
  value => { value.players[0].hand.push(value.players[0].deck[0]); },
  value => { value.players[0].don.active = -1; },
  value => { value.players[0].don.active = 9; },
  value => { value.players[0].leader.id = 'p1-leader'; },
  value => { value.players[0].deck[0].id = 'p1-main-0'; },
  value => { value.players[0].deck[0].don = 1; },
  value => { value.players[0].deck[0].powerModifier = Infinity; },
  value => { value.players[0].life[0].faceUp = 'true'; },
  value => { value.players[0].characters[1].slot = value.players[0].characters[0].slot; },
  value => { value.players[0].characters[0].slot = 5; },
  value => { value.players[0].characters[0].slot = -1; },
  value => { value.players[0].characters[0].slot = 1.5; },
  value => { value.players[0].characters[0].slot = '1'; },
  value => { value.players[0].deck[0].slot = 0; },
  value => { value.players[0].leader.slot = 0; },
  value => { value.phase = 'fake'; },
  value => { value.players = null; },
  value => { value.log = [{ text: '<script>' }]; },
  value => { value.result = { winner: 99 }; }
]) {
  const corrupted = clone(session); tamper(corrupted);
  assert.equal(validateSession(corrupted).valid, false);
  assert.throws(() => act(corrupted, 'draw'));
}
assert.equal(validateSession(null).valid, false);
assert.equal(validateSession({}).valid, false);
assert.throws(() => act(session, 'draw', { player: 2 }), /lato/);
assert.throws(() => act(session, 'unknown'), /riconosciuta/);

for (let index = 0; index < 205; index++) session = act(session, 'toggleRest', { cardId: session.players[0].leader.id });
assert.equal(session.log.length, 200, 'local log is bounded');
const finished = act(session, 'finish', { winner: 0, notes: 'Matchup di prova' });
assert.equal(finished.result.winner, 0);
assert.equal(finished.result.notes, 'Matchup di prova');
assert.equal(session.result, null, 'result is immutable and can be undone by restoring prior state');
assert.throws(() => act(finished, 'draw'), /conclusa/);
assert.throws(() => act(session, 'finish', { winner: 'invalid' }), /risultato/);
assert.equal(validateSession(JSON.parse(JSON.stringify(finished))).valid, true, 'saved session round-trip validates');
integrity(finished);

// Exercise mixed valid manual actions and reject invalid actions without drift.
for (let round = 0; round < 4; round++) {
  let fuzzed = started();
  for (let index = 0; index < 90; index++) {
    const player = index % 2, side = fuzzed.players[player];
    const source = ZONES[index % ZONES.length];
    const card = side[source][0];
    const action = index % 9 === 0 ? { type: 'nextTurn' }
      : index % 9 === 1 ? { type: 'addDon', player }
      : index % 9 === 2 ? { type: 'attachDon', player, cardId: side.leader.id }
      : index % 9 === 3 ? { type: 'restDon', player }
      : index % 9 === 4 ? { type: 'refresh', player }
      : index % 9 === 5 ? { type: 'draw', player }
      : { type: 'move', player, cardId: card?.id, to: ZONES[(index + 1) % ZONES.length] };
    const snapshot = JSON.stringify(fuzzed);
    try { fuzzed = applyAction(fuzzed, action); } catch { assert.equal(JSON.stringify(fuzzed), snapshot); }
    integrity(fuzzed);
  }
}
console.log('One Piece simulator engine: setup, mulligan, Life ordering, fixed Character slots, typed play areas, board-only commands, DON!!, phases, result, save integrity and conservation passed.');
