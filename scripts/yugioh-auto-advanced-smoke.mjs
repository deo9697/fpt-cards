// SPDX-License-Identifier: AGPL-3.0-or-later
// Real pinned Lua/WASM scenarios. Decks use published, TCG-legal cards and
// ordinary player choices; no state edits, test-mode flags or simulated effects.
import assert from 'node:assert/strict';
import { createAutoState, applyAutoInput, projectAutoState } from '../api/_yugioh-auto-core.js';
import { loadAutoResources } from '../api/_yugioh-auto-resources.js';
import { OcgType } from 'ocgcore-wasm';

const resources = await loadAutoResources();
const seed = 'f0435612789abcde'.repeat(4);
const base = [...resources.cards.values()].filter(card => card.ot >= 1 && card.ot <= 3 && (card.ot & 2) && card.type === (OcgType.MONSTER | OcgType.NORMAL) && card.level <= 4 && card.attack > 0).slice(0, 40).map(card => card.code);
const C = { DOUBLE:43422537, TUNER:21615956, ALEX:43096270, FISH:23771716, SYNCHRO:43385557, POLY:24094653, AVIAN:21844576, BURST:58932615, FUSION:35809262, XYZ:12014404, LINK:98978921, HIGH:51531505, LOW:15146890, BREAKER:71413901, EXCHANGE:5556668 };
const promptOf = state => state.publicViews[0].auto.prompt || state.publicViews[1].auto.prompt;
const own = (state, player) => state.publicViews[player].players[player];
const field = (state, player) => own(state, player).monsters.concat(own(state, player).extraMonsters);
const idle = player => state => promptOf(state)?.kind === 'idle' && promptOf(state)?.player === player;
async function choose(state, choice) { const prompt = promptOf(state); assert(prompt, 'Expected a core prompt'); return applyAutoInput(state, { viewer:prompt.player, promptId:prompt.id, choice }); }
function exactSum(prompt) {
  const mandatory = (prompt.mandatory || []).reduce((sum, option) => sum + (option.contributions?.[0] || 0), 0);
  const search = (index, sum, selected) => {
    if (sum === prompt.amount && selected.length >= prompt.min && selected.length <= prompt.max) return selected;
    if (index >= prompt.options.length || selected.length >= prompt.max || sum > prompt.amount) return null;
    for (const amount of prompt.options[index].contributions || [0]) { const found = search(index + 1, sum + amount, selected.concat(prompt.options[index].id)); if (found) return found; }
    return search(index + 1, sum, selected);
  };
  const selection = search(0, mandatory, []); assert(selection, `No legal test sum ${JSON.stringify(prompt)}`); return { optionIds:selection };
}
function automaticChoice(prompt, { defense = false } = {}) {
  if (prompt.kind === 'chain') return { optionId:prompt.options.find(option => option.id === 'pass')?.id || prompt.options[0].id };
  if (prompt.kind === 'yes-no') return { optionId:'no' };
  if (prompt.kind === 'toggle') return prompt.canFinish ? { optionId:'finish' } : { optionId:prompt.options.find(option => !option.selected)?.id || prompt.options[0].id };
  if (prompt.kind === 'sum') return exactSum(prompt);
  if (['select','tribute','place','sort','race','attribute'].includes(prompt.kind)) return { optionIds:prompt.options.slice(0, prompt.min).map(option => option.id) };
  if (prompt.kind === 'position') return { optionId:prompt.options.find(option => option.id === (defense ? 'position-4' : 'position-1'))?.id || prompt.options[0].id };
  return { optionId:prompt.options[0]?.id };
}
async function until(state, predicate, respond = automaticChoice) {
  for (let step = 0; step < 100; step++) {
    if (predicate(state)) return state;
    const prompt = promptOf(state); assert(prompt, `Duel ended early at ${step}`);
    assert(!['idle','battle'].includes(prompt.kind), `Unexpected ${prompt.kind}: ${JSON.stringify(prompt)}`);
    state = await choose(state, respond(prompt, state));
  }
  assert.fail('Scenario exceeded its prompt budget');
}
async function command(state, predicate) {
  const prompt = promptOf(state), option = prompt.options.find(predicate); assert(option, `Missing command ${JSON.stringify(prompt)}`);
  return choose(state, { optionId:option.id });
}
async function play(state, action, code, response = automaticChoice) {
  state = await command(state, option => option.action === action && option.card?.code === code);
  return until(state, idle(0), response);
}
async function end(state, target) { state = await command(state, option => option.id === 'to_ep'); return until(state, idle(target)); }

// The seed defines a permutation independently of card identities. Determine
// ordinary deck positions once, then build legal decks with deliberate openings.
const initial = await createAutoState({ decks:[{ main:base }, { main:base }], seed });
function opening(player, codes) {
  const cards = [...base];
  own(initial, player).hand.slice(0, codes.length).forEach((card, index) => { cards[base.indexOf(card.code)] = codes[index]; });
  return cards;
}
async function scenario(codes, extra = [], guest = [], firstPlayer = 0, lp = [8000, 8000]) {
  const state = await createAutoState({ decks:[{ name:'Legal scenario A', main:opening(0, codes), extra }, { name:'Legal scenario B', main:opening(1, guest) }], firstPlayer, lp, seed });
  for (const code of codes) assert(own(state, 0).hand.some(card => card.code === code), `Opening missing ${resources.cards.get(code)?.name}`);
  return state;
}

// Fusion script selects both named materials from hand and sends them to GY.
let state = await scenario([C.POLY, C.AVIAN, C.BURST], [C.FUSION]);
state = await play(state, 'activate', C.POLY);
assert(field(state, 0).some(card => card.code === C.FUSION));
for (const code of [C.POLY, C.AVIAN, C.BURST]) assert(own(state, 0).graveyard.some(card => card.code === code));
assert.equal(own(state, 0).extra.length, 0);
console.log('PASS real Polymerization Fusion, named hand materials and automatic graveyard movement');

// Synchro rules require the actual Tuner and matching Levels. A regular extra
// Normal Summon effect supplies the second monster without manual field edits.
state = await scenario([C.DOUBLE, C.TUNER, C.ALEX], [C.SYNCHRO]);
assert(!promptOf(state).options.some(option => option.action === 'special-summon' && option.card?.code === C.SYNCHRO));
state = await play(state, 'activate', C.DOUBLE);
state = await play(state, 'summon', C.TUNER);
assert(!promptOf(state).options.some(option => option.action === 'special-summon' && option.card?.code === C.SYNCHRO));
state = await play(state, 'summon', C.ALEX);
state = await play(state, 'special-summon', C.SYNCHRO, prompt => automaticChoice(prompt, { defense:true }));
assert(field(state, 0).some(card => card.code === C.SYNCHRO && card.position === 'defense'));
for (const code of [C.TUNER, C.ALEX]) assert(own(state, 0).graveyard.some(card => card.code === code));
console.log('PASS real Synchro eligibility, Tuner + Level total, material selection and Defense summon');

// Xyz materials remain attached; Gagaga Cowboy detaches exactly one as cost,
// then its Defense effect inflicts 800 damage using the actual card script.
state = await scenario([C.DOUBLE, C.ALEX, C.FISH], [C.XYZ]);
state = await play(state, 'activate', C.DOUBLE);
state = await play(state, 'summon', C.ALEX); state = await play(state, 'summon', C.FISH);
state = await play(state, 'special-summon', C.XYZ, prompt => automaticChoice(prompt, { defense:true }));
let xyz = field(state, 0).find(card => card.code === C.XYZ);
assert(xyz); assert.equal(xyz.rank, 4); assert.equal(xyz.materials.length, 2);
assert.deepEqual(xyz.materials.map(card => card.code).sort(), [C.ALEX, C.FISH].sort());
assert(!own(state, 0).graveyard.some(card => [C.ALEX, C.FISH].includes(card.code)));
assert.equal(field(state, 1).length, 0);
state = await play(state, 'activate', C.XYZ);
xyz = field(state, 0).find(card => card.code === C.XYZ);
assert.equal(xyz.materials.length, 1); assert.equal(own(state, 1).lp, 7200);
assert.equal(own(state, 0).graveyard.filter(card => [C.ALEX, C.FISH].includes(card.code)).length, 1);
assert.deepEqual(state.publicViews[0].players[0].monsters, state.publicViews[1].players[0].monsters);
console.log('PASS real Xyz Rank/material overlays, detach cost and automatic 800 damage');

// A Link requires a normal material, occupies an Extra Monster Zone and offers
// face-up Attack only. Its metadata and arrow mask must survive the query.
state = await scenario([C.ALEX], [C.LINK]);
state = await play(state, 'summon', C.ALEX);
let sawLinkPosition = false;
state = await play(state, 'special-summon', C.LINK, prompt => {
  if (prompt.kind === 'position') { sawLinkPosition = true; assert(prompt.options.every(option => option.id === 'position-1')); }
  return automaticChoice(prompt);
});
const link = field(state, 0).find(card => card.code === C.LINK);
assert(link); assert.equal(link.position, 'attack'); assert.equal(link.linkRating, 1); assert.equal(link.linkMarkers, 2);
assert.equal(own(state, 0).extraMonsters.length, 1); assert(own(state, 0).graveyard.some(card => card.code === C.ALEX));
console.log(`PASS real Link materials, Extra Monster Zone and Link metadata${sawLinkPosition ? '/Attack-only choice' : ''}`);

// Scale 1/8 allows the ordinary Level-4 Normal Monsters in hand. Pendulum cards
// occupy the two outer S/T zones under modern TCG field rules.
state = await scenario([C.HIGH, C.LOW, C.ALEX, C.FISH]);
state = await play(state, 'activate', C.HIGH); state = await play(state, 'activate', C.LOW);
const scales = own(state, 0).spells.filter(card => [C.HIGH, C.LOW].includes(card.code));
assert.equal(scales.length, 2); assert.deepEqual(scales.map(card => card.slot).sort(), [0, 4]);
assert(scales.some(card => card.leftScale === 1)); assert(scales.some(card => card.rightScale === 8));
const pendulumCommand = promptOf(state).options.find(option => option.action === 'special-summon');
assert(pendulumCommand, `Pendulum summon not offered: ${JSON.stringify(promptOf(state))}`);
state = await choose(state, { optionId:pendulumCommand.id });
state = await until(state, idle(0), prompt => {
  if (prompt.kind === 'toggle') {
    const option = prompt.options.find(item => !item.selected && [C.ALEX, C.FISH].includes(item.card?.code));
    if (option) return { optionId:option.id };
  }
  if (prompt.kind === 'select') {
    const options = prompt.options.filter(option => [C.ALEX, C.FISH].includes(option.card?.code));
    if (options.length) return { optionIds:options.slice(0, prompt.max).map(option => option.id) };
  }
  return automaticChoice(prompt);
});
assert(field(state, 0).some(card => card.code === C.ALEX)); assert(field(state, 0).some(card => card.code === C.FISH));
console.log('PASS real Pendulum scale placement, scale metadata and multi-monster Pendulum Summon');

// Breaker gains a real spell counter on summon; query kind/count ordering must
// preserve one counter and the continuous ATK bonus.
state = await scenario([C.BREAKER]);
state = await play(state, 'summon', C.BREAKER);
const breaker = field(state, 0).find(card => card.code === C.BREAKER);
assert.equal(breaker.counters, 1); assert.equal(breaker.counterTypes['1'], 1); assert.equal(breaker.atk, 1900);
console.log('PASS real spell counter query, counter type/count and continuous ATK update');

// Exchange reveals both hands before either player chooses. Actor-specific
// prompt redaction must preserve the identities explicitly revealed by script.
state = await scenario([C.EXCHANGE, C.ALEX], [], [C.FISH]);
let exchangeSelections = 0;
state = await play(state, 'activate', C.EXCHANGE, prompt => {
  if (prompt.kind === 'select') {
    exchangeSelections++;
    assert(prompt.options.every(option => option.card?.code > 0 && !option.card?.hidden), 'Exchange choices must show the opponent cards already revealed by its effect');
    const code = prompt.player === 0 ? C.FISH : C.ALEX;
    const option = prompt.options.find(item => item.card?.code === code); assert(option);
    return { optionIds:[option.id] };
  }
  return automaticChoice(prompt);
});
assert.equal(exchangeSelections, 2); assert(own(state, 0).hand.some(card => card.code === C.FISH)); assert(own(state, 1).hand.some(card => card.code === C.ALEX));
assert(state.publicViews[0].players[1].hand.every(card => card.hidden), 'Exchange reveal does not permanently make the whole opponent hand public');
console.log('PASS real Exchange reveal recipients, revealed-hand selection and post-resolution private hand');

// A set defender stays private before battle and becomes public in Damage Step.
// The next direct attack wins from authoritative ATK; neither input carries LP.
state = await scenario([C.ALEX, C.FISH], [], [C.FISH], 0, [8000, 1500]);
state = await play(state, 'summon', C.ALEX); state = await end(state, 1);
state = await command(state, option => option.action === 'monster-set' && option.card?.code === C.FISH);
state = await until(state, idle(1));
assert(state.publicViews[0].players[1].monsters[0].hidden);
assert(!JSON.stringify([projectAutoState(state, 0).players[1], projectAutoState(state, 0).log]).includes('7 Colored Fish'));
state = await end(state, 0); state = await play(state, 'summon', C.FISH);
state = await command(state, option => option.id === 'to_bp');
state = await until(state, current => promptOf(current)?.kind === 'battle');
state = await command(state, option => option.action === 'attack' && option.card?.code === C.ALEX);
state = await until(state, current => promptOf(current)?.kind === 'battle');
assert(own(state, 1).graveyard.some(card => card.code === C.FISH)); assert.equal(own(state, 1).lp, 1500, 'No piercing damage against Defense');
state = await command(state, option => option.action === 'attack' && option.card?.code === C.FISH);
for (let step = 0; step < 100 && !state.result; step++) { const prompt = promptOf(state); assert(prompt); state = await choose(state, automaticChoice(prompt)); }
assert.equal(state.result.winner, 0); assert.equal(own(state, 1).lp, 0); assert.equal(promptOf(state), null);
assert(state.publicViews.every(view => view.status === 'finished' && view.result.winner === 0));
await assert.rejects(() => applyAutoInput(state, { viewer:0, promptId:'old', choice:{ optionId:'to_ep' } }), /conclusa/);
console.log('PASS real hidden-defense battle, automatic destruction, direct lethal and terminal response guard');
console.log('yugioh-auto-advanced-smoke: OK (actual pinned TCG core/scripts, no runtime network or manual state edits)');
