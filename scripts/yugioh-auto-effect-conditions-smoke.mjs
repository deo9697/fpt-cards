// SPDX-License-Identifier: AGPL-3.0-or-later
// Exercise actual branches of the pinned Lua scripts through legal TCG inputs.
import assert from 'node:assert/strict';
import {createAutoState, applyAutoInput} from '../api/_yugioh-auto-core.js';
import {ERRATA_AUTO_RESOURCE_VERSION,loadAutoResources} from '../api/_yugioh-auto-resources.js';

const resources = await loadAutoResources();
const seed = '9f3c28ad516e470b'.repeat(4);
const C = {macabre:60921537, elimination:69832741, relic:48654323, dragon:43096270, foolish:81439173, goat:73915051, lonefire:48686504, spore:11747708};
const horus = {up:25290459, down:90500169, lv4:75830094, lv6:11224103, lv8:48229808};
const normal = [...resources.cards.values()].filter(card => card.ot === 3 && card.type === 17 && !card.alias && card.level <= 4 && card.code !== C.dragon).slice(0, 40).map(card => card.code);
const baseline = await createAutoState({decks:[{main:normal},{main:normal}], seed});
const own = (state, player) => state.publicViews[player].players[player];
const prompt = state => state.publicViews[0].auto.prompt || state.publicViews[1].auto.prompt;
const main = player => state => prompt(state)?.kind === 'idle' && prompt(state).player === player;

function deck(player, hand, extra = [], buried = []) {
  const codes = [...normal];
  const slots = own(baseline, player).hand.map(card => normal.indexOf(card.code));
  hand.forEach((code, index) => { codes[slots[index]] = code; });
  [...codes.keys()].filter(index => !slots.includes(index)).slice(0, buried.length).forEach((slot, index) => { codes[slot] = buried[index]; });
  return {main:codes,extra};
}

async function reply(state, choice) {
  const decision = prompt(state);
  assert(decision, 'Expected an engine decision');
  return applyAutoInput(state, {viewer:decision.player,promptId:decision.id,choice});
}

function standard(decision) {
  if (decision.kind === 'yes-no') return {optionId:'no'};
  if (decision.kind === 'toggle' && decision.canFinish) return {optionId:'finish'};
  if (decision.kind === 'toggle') return {optionId:decision.options.find(option => !option.selected)?.id};
  if (['select','place','tribute'].includes(decision.kind)) return {optionIds:decision.options.slice(0, decision.min).map(option => option.id)};
  return {optionId:decision.options.find(option => option.id === 'pass' || option.id === 'position-1')?.id || decision.options[0]?.id};
}

async function advance(state, stop, choose = standard) {
  for (let i = 0; i < 80; i++) {
    if (stop(state)) return state;
    assert(prompt(state) && !['idle','battle'].includes(prompt(state).kind), `Unexpected decision in ${state.publicViews[0].phase}: ${JSON.stringify(prompt(state))}`);
    state = await reply(state, choose(prompt(state)));
  }
  assert.fail('Engine did not reach expected decision');
}

async function command(state, id, action) {
  const option = prompt(state).options.find(row => action ? row.action === action && row.card?.code === id : row.id === id);
  assert(option, `Missing core command ${action || ''} ${id} in ${JSON.stringify(prompt(state))}`);
  return reply(state, {optionId:option.id});
}

async function summonMacabre(resourceVersion) {
  let state = await createAutoState({decks:[deck(0,[C.elimination,C.macabre,C.relic,C.dragon]),deck(1,[])], seed, resourceVersion});
  state = await advance(await command(state,C.elimination,'activate'),main(0));
  state = await advance(await command(state,C.macabre,'activate'),main(0),decision => {
    const material = decision.options.find(option => option.card?.code === C.dragon && !option.selected);
    if (material && decision.kind === 'sum') return {optionIds:[material.id]};
    if (material && decision.kind === 'toggle') return {optionId:material.id};
    return standard(decision);
  });
  assert(own(state,0).monsters.some(card => card.code === C.relic), 'Macabre Ritual Summons White Relic');
  assert(own(state,0).graveyard.some(card => card.code === C.dragon), 'The hand tribute is paid');
}

async function summonSpore(resourceVersion) {
  let state = await createAutoState({decks:[deck(0,[C.foolish,C.goat,C.lonefire,C.elimination],[],[C.spore]),deck(1,[])], seed, resourceVersion});
  state = await advance(state,main(0));
  state = await advance(await command(state,C.foolish,'activate'),main(0),decision => {
    const spore = decision.options.find(option => option.card?.code === C.spore);
    return spore && decision.kind === 'select' ? {optionIds:[spore.id]} : standard(decision);
  });
  assert(own(state,0).graveyard.some(card => card.code === C.spore));
  state = await advance(await command(state,C.goat,'spell-set'),main(0));
  state = await advance(await command(state,'to_ep'),main(1));
  const afterGoat = state => main(0)(state) || main(1)(state) && own(state,0).monsters.length === 4;
  state = await advance(await command(state,'to_ep'),afterGoat,decision => {
    const goat = decision.player === 0 && decision.kind === 'chain' && decision.options.find(option => option.card?.code === C.goat);
    return goat ? {optionId:goat.id} : standard(decision);
  });
  if (main(1)(state)) state = await advance(await command(state,'to_ep'),main(0));
  assert.equal(own(state,0).monsters.filter(card => card.token).length,4);
  state = await advance(await command(state,C.lonefire,'summon'),main(0));
  assert.equal(own(state,0).monsters.length,5);
  assert(!prompt(state).options.some(option => option.card?.code === C.spore && option.action === 'activate'));
  state = await advance(await command(state,C.elimination,'activate'),main(0));
  state = await advance(await command(state,C.spore,'activate'),main(0),decision => {
    const plant = decision.options.find(option => option.card?.code === C.lonefire);
    return plant && decision.kind === 'select' ? {optionIds:[plant.id]} : standard(decision);
  });
  assert(own(state,0).banished.some(card => card.code === C.lonefire), 'Spore pays its Plant cost from the full Main Monster Zone');
  const spore = own(state,0).monsters.find(card => card.code === C.spore);
  assert.equal(spore?.level,4,'Spore uses the newly freed zone and gains the banished Plant’s Level');
  assert.equal(own(state,0).monsters.length,5);
}

async function prepareHorus(resourceVersion) {
  let state = await createAutoState({decks:[deck(0,[horus.lv4,horus.up,horus.up,horus.down],[],[horus.lv6,horus.lv8]),deck(1,[])],seed,resourceVersion});
  state = await advance(state,main(0));
  state = await advance(await command(state,horus.lv4,'summon'),main(0));
  state = await advance(await command(state,horus.up,'activate'),main(0));
  state = await advance(await command(state,horus.up,'activate'),main(0));
  assert(own(state,0).monsters.some(card => card.code === horus.lv8));
  assert(own(state,0).graveyard.some(card => card.code === horus.lv6));
  return state;
}

const broken = await loadAutoResources(ERRATA_AUTO_RESOURCE_VERSION);
assert.equal(resources.scripts.size,broken.scripts.size);
const changed = [...resources.scripts].filter(([name, script]) => script !== broken.scripts.get(name)).map(([name]) => name).sort();
const fixedScripts = [C.macabre,C.spore,horus.lv4,horus.lv6,horus.lv8].flatMap(code => [`c${code}.lua`,`official/c${code}.lua`]);
assert.deepEqual(changed,fixedScripts.sort());
await assert.rejects(() => summonMacabre(ERRATA_AUTO_RESOURCE_VERSION), {code:'engine_script_error'});
await assert.rejects(() => summonSpore(ERRATA_AUTO_RESOURCE_VERSION), {code:'engine_script_error'});
await summonMacabre();
console.log('PASS Dogmatikamacabre still Ritual Summons with legal hand materials after Spirit Elimination.');
await summonSpore();
console.log('PASS Spore banishes a Plant on a full Main Monster Zone under Spirit Elimination, then revives and gains its Level.');
const oldHorus = await prepareHorus(ERRATA_AUTO_RESOURCE_VERSION);
assert(!prompt(oldHorus).options.some(option => option.card?.code === horus.down && option.action === 'activate'), 'Reproduce the previous profile omitting Level Down');
let newHorus = await prepareHorus();
newHorus = await advance(await command(newHorus,horus.down,'activate'),main(0),decision => {
  const lower = decision.options.find(option => option.card?.code === horus.lv6);
  return lower && decision.kind === 'select' ? {optionIds:[lower.id]} : standard(decision);
});
assert(own(newHorus,0).monsters.some(card => card.code === horus.lv6));
assert(!own(newHorus,0).monsters.some(card => card.code === horus.lv8));
assert.equal(own(newHorus,0).deck.length,34,'LV8 returns to the Deck');
console.log('PASS Level Down!? recognizes the Horus family, returns LV8 and revives LV6.');
