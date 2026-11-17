// SPDX-License-Identifier: AGPL-3.0-or-later
// Live adapter tests: ordinary legal decks, pinned official card scripts, and
// player choices only. No injected Lua, board edits, or test-only engine flags.
import assert from 'node:assert/strict';
import {createAutoState, applyAutoInput, searchAutoCards} from '../api/_yugioh-auto-core.js';
import {loadAutoResources} from '../api/_yugioh-auto-resources.js';
import {resolveChoice, searchPromptCards} from '../api/_yugioh-auto-prompts.js';

const resources = await loadAutoResources(), seed = 'bc439e8017625afd'.repeat(4);
const base = [...resources.cards.values()].filter(card => card.ot === 3 && card.type === 17 && !card.alias && card.level <= 4 && card.attack > 0).slice(0, 40).map(card => card.code);
const C = {PROHIBITION:43711255, REASONING:58577036, HUNTER:1525329, DNA:56769674, DRONE:4474060, DOUBLE:43422537, EXEMPLAR:6061630, MAGIA:59080, FORTRESS:5556499, MACHINE:7359741, JUNK:63977008, TUNINGWARE:92676637, CATASTOR:26593852, GEAR:58297729, ALEX:43096270, FEAST:31548814, VANISHMENT:78748366, DECATRON:58446973, HARMADIK:52038272, PATRULEA:89423971, AXE:40619825, CHANGE:4031928, MST:5318639, UPSTART:70368879, CALL:97077563, FOOLISH:81439173, DUGG:24079759, COWBOY:12014404, BOOK:14087893};
const own = (state, player) => state.publicViews[player].players[player];
const promptOf = state => state.publicViews[0].auto.prompt || state.publicViews[1].auto.prompt;
const idle = player => state => promptOf(state)?.kind === 'idle' && promptOf(state).player === player;
const seen = new Set(), observed = [];
async function choose(state, choice) {
  const prompt = promptOf(state); assert(prompt, 'Expected a live prompt');
  seen.add(prompt.kind); observed.push(state.pendingMessage.type);
  return applyAutoInput(state, {viewer: prompt.player, promptId: prompt.id, choice});
}
function defaultChoice(prompt) {
  if (prompt.kind === 'chain') return {optionId: prompt.options.find(option => option.id === 'pass')?.id || prompt.options[0].id};
  if (prompt.kind === 'yes-no') return {optionId: 'no'};
  if (prompt.kind === 'toggle') return {optionId: prompt.canFinish ? 'finish' : prompt.options.find(option => !option.selected)?.id || prompt.options[0].id};
  if (['select', 'tribute', 'place', 'sort', 'race', 'attribute'].includes(prompt.kind)) return {optionIds: prompt.options.slice(0, prompt.min).map(option => option.id)};
  if (prompt.kind === 'position') return {optionId: prompt.options.find(option => option.id === 'position-1')?.id || prompt.options[0].id};
  return {optionId: prompt.options[0]?.id};
}
async function until(state, predicate, respond = defaultChoice) {
  for (let count = 0; count < 80; count++) {
    if (predicate(state)) return state;
    const prompt = promptOf(state); assert(prompt, 'Duel ended before the expected prompt');
    assert(!['idle', 'battle'].includes(prompt.kind), `Unexpected ${prompt.kind}: ${JSON.stringify(prompt)}`);
    state = await choose(state, respond(prompt, state));
  }
  assert.fail('Prompt budget exceeded');
}
async function command(state, predicate) {
  const prompt = promptOf(state), option = prompt.options.find(predicate);
  assert(option, `Missing legal command ${JSON.stringify(prompt)}`);
  return choose(state, {optionId: option.id});
}
async function play(state, action, code, respond = defaultChoice, destination = 0) {
  return until(await command(state, option => option.action === action && option.card?.code === code), idle(destination), respond);
}
async function end(state, target, respond = defaultChoice) { return until(await command(state, option => option.id === 'to_ep'), idle(target), respond); }
const initial = await createAutoState({decks: [{main: base}, {main: base}], seed});
const withSide = await createAutoState({decks: [{main: base, side: [base[0]]}, {main: base}], seed});
assert.equal(own(withSide, 0).side[0].owner, 0);
assert.deepEqual(own(withSide, 0).side[0].targets, []);
assert(withSide.publicViews[1].players[0].side[0].hidden);
assert(!Object.hasOwn(withSide.publicViews[1].players[0].side[0], 'owner'));
function opening(player, codes, inDeck = []) {
  const main = [...base];
  const reserved = new Set(own(initial, player).hand.map(card => base.indexOf(card.code)));
  own(initial, player).hand.slice(0, codes.length).forEach((card, index) => { main[base.indexOf(card.code)] = codes[index]; });
  const available = [...main.keys()].filter(index => !reserved.has(index));
  inDeck.forEach((code, index) => {main[available[index]] = code;});
  return main;
}
async function scenario(host, guest = [], extra = [], inDeck = [], guestExtra = []) {
  const state = await createAutoState({decks: [{main: opening(0, host, inDeck), extra}, {main: opening(1, guest), extra: guestExtra}], seed});
  for (const [player, codes] of [[0, host], [1, guest]]) for (const code of codes) assert(own(state, player).hand.some(card => card.code === code));
  return state;
}

// AnnounceCard is constrained by live engine opcodes and never accepts raw
// responses or an unrelated/forged passcode. Forbidden cards remain nameable.
let state = await scenario([C.PROHIBITION]);
state = await command(state, option => option.action === 'activate' && option.card?.code === C.PROHIBITION);
state = await until(state, state => promptOf(state)?.kind === 'announce-card');
assert.equal(promptOf(state).kind, 'announce-card');
const saved = JSON.stringify(state), actor = promptOf(state).player;
const found = await searchAutoCards(state, {viewer: actor, promptId: promptOf(state).id, query: 'Blue-Eyes White Dragon'});
assert(found.some(card => card.code === 89631139));
await assert.rejects(() => searchAutoCards(state, {viewer: 1 - actor, promptId: promptOf(state).id, query: 'Blue'}));
await assert.rejects(() => choose(state, {value: 1234567890})); assert.equal(JSON.stringify(state), saved);
state = await until(await choose(state, {value: 89631139}), idle(0));
assert(own(state, 0).spells.some(card => card.code === C.PROHIBITION && card.faceUp));
console.log('PASS live Prohibition card declaration, authorized search and forged-choice rejection');

// Reasoning asks the opposing seat for a Level. The wire value is its option
// index; choosing Level 12 must transmit its index rather than its value.
state = await scenario([C.REASONING]);
let number = false;
state = await play(state, 'activate', C.REASONING, (prompt) => {
  if (prompt.kind === 'announce-number') {
    number = true; assert.equal(prompt.player, 1);
    const option = prompt.options.find(option => option.label === '12'); assert(option);
    return {optionId: option.id};
  }
  return defaultChoice(prompt);
});
assert(number); assert.equal(own(state, 0).monsters.length, 1);
console.log('PASS live Reasoning opposing-seat number declaration and resulting Special Summon');

state = await scenario([C.HUNTER]);
let race = false;
state = await play(state, 'summon', C.HUNTER, prompt => {
  if (prompt.kind === 'yes-no') return {optionId: 'yes'};
  if (prompt.kind === 'race') { race = true; return {optionIds: ['race-8192']}; }
  return defaultChoice(prompt);
});
assert(race);
console.log('PASS live Hunter with 7 Weapons race declaration');

state = await scenario([C.DNA]);
state = await play(state, 'spell-set', C.DNA);
state = await end(state, 1);
state = await end(state, 0);
let attribute = false;
if (promptOf(state).options.some(option => option.card?.code === C.DNA && option.action === 'activate')) state = await play(state, 'activate', C.DNA, prompt => {
  if (prompt.kind === 'attribute') {attribute = true; return {optionIds: ['attribute-32']};}
  return defaultChoice(prompt);
});
else attribute = seen.has('attribute');
assert(attribute); assert(own(state, 0).spells.some(card => card.code === C.DNA && card.faceUp));
console.log('PASS live DNA Transplant attribute declaration');

// Sorting an opponent's Deck must actually reveal the authorized top three to
// the choosing player. The wrapper sort-response prefix is fixed by the adapter.
state = await scenario([C.DRONE]);
let sorted = false, requestedOrder = [];
state = await play(state, 'summon', C.DRONE, (prompt, current) => {
  if (prompt.kind === 'yes-no') return {optionId: 'yes'};
  if (prompt.kind === 'chain' && !prompt.options.some(option => option.id === 'pass')) return {optionId: prompt.options[0].id};
  if (prompt.kind === 'sort') {
    sorted = true; assert.equal(prompt.options.length, 3);
    assert(prompt.options.every(option => option.card.code > 0), 'Drone must expose the three cards its effect permits the actor to inspect');
    assert.equal(current.publicViews[1].auto.prompt, null, 'Sorting choices belong only to the choosing seat');
    assert(current.publicViews[0].players[1].deck.every(card => card.hidden && !card.code), 'The private sort does not publish the entire Deck');
    requestedOrder = [...prompt.options].reverse().map(option => option.card.code);
    return {optionIds: [...prompt.options].reverse().map(option => option.id)};
  }
  return defaultChoice(prompt);
});
assert(sorted);
state = await end(state, 1);
assert.equal(own(state, 1).hand.at(-1).code, requestedOrder[0], 'Opponent draws the first card in the chosen order');
console.log('PASS live SPYRAL Drone reveal, ordered sort response and next-turn draw');

// Two Exemplar counters are produced by resolving a real Spell. Magia then
// asks how to remove two counters from multiple legal sources.
state = await scenario([C.DOUBLE, C.EXEMPLAR, C.EXEMPLAR, C.PROHIBITION, C.MAGIA]);
state = await play(state, 'activate', C.DOUBLE);
state = await play(state, 'summon', C.EXEMPLAR);
state = await play(state, 'summon', C.EXEMPLAR);
state = await play(state, 'activate', C.PROHIBITION, prompt => prompt.kind === 'announce-card' ? {value: 89631139} : defaultChoice(prompt));
assert.deepEqual(own(state, 0).monsters.map(card => card.counters), [2, 2]);
let counter = false;
state = await play(state, 'activate', C.MAGIA, (prompt, current) => {
  if (prompt.kind === 'counter') {
    counter = true; assert.equal(prompt.count, 2); assert.equal(prompt.options.length, 2);
    assert.throws(() => resolveChoice(current.pendingMessage, {counts: {'counter-0': 3}}, {resources}));
    return {counts: Object.fromEntries(prompt.options.map(option => [option.id, 1]))};
  }
  if (prompt.kind === 'select') return {optionIds: [prompt.options.find(option => option.card?.code === C.PROHIBITION)?.id || prompt.options[0].id]};
  return defaultChoice(prompt);
});
assert(counter); assert.deepEqual(own(state, 0).monsters.map(card => card.counters), [3, 3]);
console.log('PASS live global counter selection, distribution, costs and later Spell-counter gain');

state = await scenario([C.FORTRESS, C.MACHINE, C.MACHINE]);
let sum = false;
state = await play(state, 'special-summon', C.FORTRESS, (prompt, current) => {
  if (prompt.kind === 'sum') {
    sum = true; assert.equal(prompt.sumMode, 'at-least-minimal');
    const fortress = prompt.options.find(option => option.card.code === C.FORTRESS), machine = prompt.options.find(option => option.card.code === C.MACHINE);
    assert.throws(() => resolveChoice(current.pendingMessage, {optionIds: prompt.options.map(option => option.id)}, {resources}));
    return {optionIds: [fortress.id, machine.id]};
  }
  return defaultChoice(prompt);
});
assert(sum); assert(own(state, 0).monsters.some(card => card.code === C.FORTRESS));
assert.equal(own(state, 0).graveyard.filter(card => card.code === C.MACHINE).length, 1);
console.log('PASS live Machina Fortress minimal at-least Level sum and rejection of surplus materials');

state = await scenario([C.FEAST, C.VANISHMENT], [], [], [C.DECATRON, C.DECATRON, C.HARMADIK, C.HARMADIK, C.PATRULEA, C.PATRULEA]);
state = await play(state, 'spell-set', C.FEAST);
state = await end(state, 1); state = await end(state, 0);
let exact = false;
state = await play(state, 'activate', C.FEAST, (prompt, current) => {
  if (prompt.kind === 'select') return {optionIds: [prompt.options.find(option => option.card?.code === C.VANISHMENT)?.id || prompt.options[0].id]};
  if (prompt.kind === 'sum') {
    exact = true; assert.equal(prompt.sumMode, 'exact'); assert.equal(prompt.amount, 8);
    assert.throws(() => resolveChoice(current.pendingMessage, {optionIds: []}, {resources}));
    const ids = [C.DECATRON, C.HARMADIK, C.PATRULEA].map(code => prompt.options.find(option => option.card?.code === code)?.id);
    assert(ids.every(Boolean)); return {optionIds: ids};
  }
  return defaultChoice(prompt);
});
assert(exact);
assert.deepEqual(own(state, 0).monsters.map(card => card.code).sort(), [C.DECATRON, C.HARMADIK, C.PATRULEA].sort());
assert(own(state, 0).graveyard.some(card => card.code === C.VANISHMENT));
console.log('PASS live Void Feast exact-Level sum, multiple Deck summons and separate Spell cost');

// Tuningware can count as Level 1 or 2 for a Synchro Summon. The modern Lua
// procedure enforces the Tuner through iterative material selection; it does
// not emit a SELECT_SUM with a mandatory-material prefix in this scenario.
state = await scenario([C.DOUBLE, C.JUNK, C.TUNINGWARE], [], [C.CATASTOR]);
state = await play(state, 'activate', C.DOUBLE);
state = await play(state, 'summon', C.JUNK);
state = await play(state, 'summon', C.TUNINGWARE);
state = await play(state, 'special-summon', C.CATASTOR, (prompt, current) => {
  if (prompt.kind === 'sum') {
    const ids = prompt.options.map(option => option.id);
    // The actual engine provided the candidate set. Validate every subset,
    // then submit one legal set; this does not synthesize a protocol message.
    for (let bits = 0; bits < 1 << ids.length; bits++) {
      const choice = {optionIds: ids.filter((_, index) => bits & 1 << index)};
      try {resolveChoice(current.pendingMessage, choice, {resources}); return choice;} catch {}
    }
    assert.fail('No legal alternate-level material selection');
  }
  if (prompt.kind === 'yes-no') return {optionId: 'yes'};
  return defaultChoice(prompt);
});
assert(own(state, 0).monsters.concat(own(state, 0).extraMonsters).some(card => card.code === C.CATASTOR));
console.log('PASS live Tuningware alternate-Level Synchro outcome (current procedure uses iterative material toggles)');

// Transmission Gear runs rock-paper-scissors during damage calculation. Both
// players choose and the actual card effect banishes only the losing monster.
state = await scenario([C.GEAR, C.ALEX], [C.MACHINE]);
state = await play(state, 'spell-set', C.GEAR);
state = await play(state, 'summon', C.ALEX);
state = await end(state, 1);
state = await play(state, 'summon', C.MACHINE, defaultChoice, 1);
state = await end(state, 0);
state = await until(await command(state, option => option.id === 'to_bp'), state => promptOf(state)?.kind === 'battle');
state = await command(state, option => option.action === 'attack' && option.card?.code === C.ALEX);
const rpsSeats = new Set(); let activatedGear = false;
state = await until(state, state => promptOf(state)?.kind === 'battle', prompt => {
  if (prompt.kind === 'chain') {
    const gear = prompt.options.find(option => option.card?.code === C.GEAR);
    if (gear) {activatedGear = true; return {optionId: gear.id};}
  }
  if (prompt.kind === 'rps') {rpsSeats.add(prompt.player); return {optionId: prompt.player === 0 ? 'rps-2' : 'rps-1'};}
  return defaultChoice(prompt);
});
assert(activatedGear); assert.deepEqual([...rpsSeats].sort(), [0, 1]);
assert(own(state, 0).monsters.some(card => card.code === C.ALEX));
assert.equal(own(state, 1).monsters.length, 0);
assert(own(state, 1).banished.some(card => card.code === C.MACHINE && !card.faceUp));
assert(state.publicViews[0].players[1].banished.every(card => card.hidden && !card.code));
console.log('PASS live Transmission Gear two-player RPS, rule banish and covered opponent privacy');

// The query bridge reads owner, equip and target TLVs independently from the
// wrapper's parser. Coordinates follow control changes; ownership does not.
state = await scenario([C.ALEX, C.AXE, C.MST], [C.CHANGE, C.UPSTART]);
state = await play(state, 'summon', C.ALEX);
state = await play(state, 'spell-set', C.MST);
const targetCode = code => prompt => prompt.kind === 'select' ? {optionIds: [prompt.options.find(option => option.card?.code === code)?.id || prompt.options[0].id]} : defaultChoice(prompt);
state = await play(state, 'activate', C.AXE, targetCode(C.ALEX));
let axe = own(state, 0).spells.find(card => card.code === C.AXE), monster = own(state, 0).monsters.find(card => card.code === C.ALEX);
assert.equal(axe.owner, 0); assert.equal(monster.owner, 0); assert.equal(monster.atk, 3000);
assert.deepEqual(axe.equippedTo, {controller: 0, location: 4, sequence: monster.sequence});
assert.deepEqual(state.publicViews[1].players[0].spells.find(card => card.code === C.AXE).equippedTo, axe.equippedTo);
state = await end(state, 1);
state = await play(state, 'activate', C.CHANGE, targetCode(C.ALEX), 1);
axe = own(state, 0).spells.find(card => card.code === C.AXE); monster = own(state, 1).monsters.find(card => card.code === C.ALEX);
assert.equal(monster.controller, 1); assert.equal(monster.owner, 0);
assert.deepEqual(axe.equippedTo, {controller: 1, location: 4, sequence: monster.sequence});
let mst = false;
state = await play(state, 'activate', C.UPSTART, prompt => {
  if (prompt.kind === 'chain') { const option = prompt.options.find(option => option.card?.code === C.MST); if (option) {mst = true; return {optionId: option.id};} }
  return targetCode(C.AXE)(prompt);
}, 1);
assert(mst); axe = own(state, 0).graveyard.find(card => card.code === C.AXE);
assert(axe); assert.equal(axe.equippedTo, null); assert.deepEqual(axe.targets, []);
assert.equal(own(state, 1).monsters.find(card => card.code === C.ALEX).atk, 2000);
state = await end(state, 0);
assert(own(state, 0).monsters.some(card => card.code === C.ALEX && card.owner === 0 && card.controller === 0));
console.log('PASS live Axe equip relation, control-versus-owner, removal and cleared equip coordinates');

state = await scenario([C.CALL, C.FOOLISH, C.MST], [], [], [C.ALEX]);
state = await play(state, 'spell-set', C.CALL);
state = await play(state, 'activate', C.FOOLISH, targetCode(C.ALEX));
state = await end(state, 1); state = await end(state, 0);
state = await play(state, 'activate', C.CALL, targetCode(C.ALEX));
let call = own(state, 0).spells.find(card => card.code === C.CALL); monster = own(state, 0).monsters.find(card => card.code === C.ALEX);
assert.deepEqual(call.targets, [{controller: 0, location: 4, sequence: monster.sequence}]);
assert.deepEqual(state.publicViews[1].players[0].spells.find(card => card.code === C.CALL).targets, call.targets);
state = await play(state, 'activate', C.MST, targetCode(C.CALL));
call = own(state, 0).graveyard.find(card => card.code === C.CALL);
assert(call); assert.deepEqual(call.targets, []); assert.equal(call.equippedTo, null);
assert(!own(state, 0).monsters.some(card => card.code === C.ALEX));
for (const view of state.publicViews) for (const player of view.players) for (const zone of ['hand', 'monsters', 'spells', 'graveyard', 'banished']) for (const card of player[zone]) {
  assert(!Object.hasOwn(card, '_targets') && !Object.hasOwn(card, '_equippedTo'));
  if (card.hidden) {assert(!Object.hasOwn(card, 'owner')); assert(!Object.hasOwn(card, 'targets')); assert(!Object.hasOwn(card, 'equippedTo'));}
}
console.log('PASS live Call of the Haunted persistent target and cleared relation after destruction');

// Dugg Charger can detach an opponent's public material. The pinned wrapper
// strips LOCATION_OVERLAY from the location and supplies overlay_sequence;
// this must remain distinguishable from the parent Xyz Monster itself.
state = await scenario([C.DUGG], [C.DOUBLE, C.ALEX, C.MACHINE], [], [], [C.COWBOY]);
state = await end(state, 1);
state = await play(state, 'activate', C.DOUBLE, defaultChoice, 1);
state = await play(state, 'summon', C.ALEX, defaultChoice, 1);
state = await play(state, 'summon', C.MACHINE, defaultChoice, 1);
state = await play(state, 'special-summon', C.COWBOY, defaultChoice, 1);
assert.equal(own(state, 1).monsters.concat(own(state, 1).extraMonsters).find(card => card.code === C.COWBOY).materials.length, 2);
state = await end(state, 0);
let overlay = false;
state = await play(state, 'activate', C.DUGG, (prompt, current) => {
  if (prompt.kind === 'select') {
    const candidates = prompt.options.filter(option => Number.isInteger(option.card?.overlay_sequence));
    if (candidates.length) {
      overlay = true; assert.equal(candidates.length, 2);
      assert(candidates.every(option => [C.ALEX, C.MACHINE].includes(option.card.code) && option.card.controller === 1));
      assert(candidates.every(option => option.card.location === 4));
      assert.equal(current.publicViews[1].auto.prompt, null);
      assert.equal(new Set(candidates.map(option => option.card.overlay_sequence)).size, 2);
      return {optionIds: [candidates.find(option => option.card.code === C.ALEX).id]};
    }
  }
  return defaultChoice(prompt);
});
assert(overlay);
assert(own(state, 0).monsters.some(card => card.code === C.DUGG));
const remainingXyz = own(state, 1).monsters.concat(own(state, 1).extraMonsters).find(card => card.code === C.COWBOY);
assert.deepEqual(remainingXyz.materials.map(card => card.code), [C.MACHINE]);
assert(own(state, 1).graveyard.some(card => card.code === C.ALEX));
assert(!state.publicViews[0].players[1].hand.some(card => !card.hidden));
console.log('PASS live Dugg Charger selects a distinct public opponent Xyz material and detaches it to the correct owner');

state = await scenario([C.DUGG, C.BOOK], [C.DOUBLE, C.ALEX, C.MACHINE], [], [], [C.COWBOY]);
state = await end(state, 1);
state = await play(state, 'activate', C.DOUBLE, defaultChoice, 1);
state = await play(state, 'summon', C.ALEX, defaultChoice, 1);
state = await play(state, 'summon', C.MACHINE, defaultChoice, 1);
state = await play(state, 'special-summon', C.COWBOY, defaultChoice, 1);
state = await end(state, 0);
state = await play(state, 'activate', C.BOOK, targetCode(C.COWBOY));
assert.equal(own(state, 1).monsters.concat(own(state, 1).extraMonsters).find(card => card.code === C.COWBOY).faceUp, false);
assert(state.publicViews[0].players[1].monsters.concat(state.publicViews[0].players[1].extraMonsters).every(card => card.hidden));
let coveredOverlay = false;
state = await play(state, 'activate', C.DUGG, (prompt, current) => {
  if (prompt.kind === 'select') {
    const candidates = prompt.options.filter(option => Number.isInteger(option.card?.overlay_sequence));
    if (candidates.length) {
      coveredOverlay = true; assert.equal(candidates.length, 2);
      assert(candidates.every(option => [C.ALEX, C.MACHINE].includes(option.card.code)), 'The face-down parent must not conceal its public Xyz materials');
      assert.equal(current.publicViews[1].auto.prompt, null);
      assert(current.publicViews[0].players[1].monsters.concat(current.publicViews[0].players[1].extraMonsters).every(card => card.hidden && !card.code), 'Revealing materials must not reveal the face-down Xyz identity');
      return {optionIds: [candidates.find(option => option.card.code === C.ALEX).id]};
    }
  }
  return defaultChoice(prompt);
});
assert(coveredOverlay);
assert(own(state, 0).monsters.some(card => card.code === C.DUGG));
assert.deepEqual(own(state, 1).monsters.concat(own(state, 1).extraMonsters).find(card => card.code === C.COWBOY).materials.map(card => card.code), [C.MACHINE]);
assert(own(state, 1).graveyard.some(card => card.code === C.ALEX));
assert(state.publicViews[0].players[1].monsters.concat(state.publicViews[0].players[1].extraMonsters).every(card => card.hidden && !card.code));
console.log('PASS live Book of Moon plus Dugg Charger exposes only the detached material while the opponent Xyz stays private');

console.log(`Live protocol kinds exercised: ${[...seen].sort().join(', ')}; message types: ${[...new Set(observed)].sort((a,b)=>a-b).join(', ')}.`);
console.log('yugioh-auto-protocol-live-smoke: OK');
