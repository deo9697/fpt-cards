// SPDX-License-Identifier: AGPL-3.0-or-later
// Actual pinned TCG Lua/WASM scenarios. No network calls, test duel flags or
// injected state transitions: every change follows a legal engine choice.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createAutoState, applyAutoInput, projectAutoState } from '../api/_yugioh-auto-core.js';
import { loadAutoResources } from '../api/_yugioh-auto-resources.js';
import { AUTO_TCG_LIMITS } from '../api/_yugioh-auto-deck-rules.js';
import { runAutoOperation } from '../api/_yugioh-auto-executor.js';
import { OcgType } from 'ocgcore-wasm';

const resources = await loadAutoResources(), seed = 'b1435612789abcde'.repeat(4);
const C = { ALEX:43096270, FISH:23771716, CONTROL:37520316, AXE:40619825, DICE:74137509, CUP:37812118, GOAT:73915051, STAR:63485233, DUALITY:98645731, DARK:53129443, DESIRES:35261759, GOLD:75500286, MOON:14087893, SUN:38699854, PIT:51531505, MST:5318639, EYE:34694160, CONVULSION:62966332 };
const EXODIA = [33396948,7902349,70903634,44519536,8124921];
const reserved = new Set([...Object.values(C), ...EXODIA]);
const base = [...resources.cards.values()].filter(card => card.ot > 0 && card.ot <= 3 && (card.ot & 2) && card.type === (OcgType.MONSTER | OcgType.NORMAL) && card.level <= 4 && card.attack > 0 && !reserved.has(card.code) && (AUTO_TCG_LIMITS[card.code] ?? 3) === 3).slice(0,40).map(card => card.code);
const clone = value => JSON.parse(JSON.stringify(value));
const promptOf = state => state.publicViews[0].auto.prompt || state.publicViews[1].auto.prompt;
const own = (state, player) => state.publicViews[player].players[player];
const field = (state, player) => own(state, player).monsters.concat(own(state, player).extraMonsters);
const idle = player => state => promptOf(state)?.kind === 'idle' && promptOf(state).player === player;
async function choose(state, choice) { const prompt = promptOf(state); assert(prompt, 'Expected an engine prompt'); return applyAutoInput(state, { viewer:prompt.player, promptId:prompt.id, choice }); }
function defaultChoice(prompt) {
  if (prompt.kind === 'chain') return { optionId:prompt.options.find(option => option.id === 'pass')?.id || prompt.options[0].id };
  if (prompt.kind === 'yes-no') return { optionId:'no' };
  if (prompt.kind === 'toggle') return prompt.canFinish ? { optionId:'finish' } : { optionId:prompt.options.find(option => !option.selected)?.id || prompt.options[0].id };
  if (['select','tribute','place','sort','race','attribute'].includes(prompt.kind)) return { optionIds:prompt.options.slice(0,prompt.min).map(option => option.id) };
  if (prompt.kind === 'position') return { optionId:prompt.options.find(option => option.id === 'position-1')?.id || prompt.options[0].id };
  return { optionId:prompt.options[0]?.id };
}
async function until(state, predicate, respond = defaultChoice, limit = 100) {
  for (let step = 0; step < limit; step++) {
    if (predicate(state)) return state;
    const prompt = promptOf(state); assert(prompt, `Duel ended unexpectedly: ${JSON.stringify(state.result)}`);
    assert(!['idle','battle'].includes(prompt.kind), `Unexpected prompt: ${JSON.stringify(prompt)}`);
    state = await choose(state, respond(prompt,state));
  }
  assert.fail('Scenario exceeded its engine-prompt budget');
}
async function command(state, predicate) { const prompt = promptOf(state), option = prompt.options.find(predicate); assert(option, `Command not offered: ${JSON.stringify(prompt)}`); return choose(state, { optionId:option.id }); }
async function play(state, action, code, respond = defaultChoice) {
  const player = promptOf(state).player;
  return until(await command(state, option => option.action === action && option.card?.code === code), idle(player), respond);
}
async function end(state, player, respond = defaultChoice) { return until(await command(state, option => option.id === 'to_ep'), idle(player), respond); }
const initial = await createAutoState({ decks:[{ main:base }, { main:base }], seed });
function opening(player,codes) { const cards = [...base]; own(initial,player).hand.slice(0,codes.length).forEach((card,index) => { cards[base.indexOf(card.code)] = codes[index]; }); return cards; }
async function scenario(codes,guest = [],options = {}) {
  let state = await createAutoState({ decks:[{ name:'State events A', main:opening(0,codes) }, { name:'State events B', main:opening(1,guest) }], seed, ...options });
  state = await until(state,current => current.result || idle(0)(current));
  for (const [player,hand] of [[0,codes],[1,guest]]) for (const code of hand) assert(own(state,player).hand.some(card => card.code === code), `Deliberate opening missing ${code}`);
  return state;
}
function assertPrivateState(state) {
  for (const viewer of [0,1]) {
    const projection = projectAutoState(state,viewer);
    for (const key of ['seed','initialDecks','inputs','pendingMessage','pendingPromptId','publicViews']) assert(!Object.hasOwn(projection,key), `Private field leaked: ${key}`);
    assert(projection.players.every(player => player.deck.every(card => card.hidden && !card.code && !card.catalogCardId)), 'Unrevealed deck identities stay private');
  }
}

// Temporary control returns during End Phase; destroying a stolen monster sends
// it to its original owner's GY rather than the current controller's GY.
let state = await scenario([C.CONTROL,C.DARK], [C.ALEX]);
state = await end(state,1); state = await play(state,'summon',C.ALEX); state = await end(state,0);
state = await play(state,'activate',C.CONTROL,prompt => prompt.kind === 'select' ? { optionIds:[prompt.options.find(option => option.card?.code === C.ALEX).id] } : defaultChoice(prompt));
assert(field(state,0).some(card => card.code === C.ALEX && card.controller === 0)); assert.equal(field(state,1).length,0);
const controlled = clone(state);
let returned = await end(controlled,1);
assert(field(returned,1).some(card => card.code === C.ALEX && card.controller === 1)); assert.equal(field(returned,0).length,0);
state = await play(state,'activate',C.DARK);
assert(own(state,1).graveyard.some(card => card.code === C.ALEX)); assert(!own(state,0).graveyard.some(card => card.code === C.ALEX));
console.log('PASS temporary control, End Phase return and destroyed stolen-card original-owner GY');

// Four genuine Sheep Tokens disappear when destroyed; they never enter a GY.
state = await scenario([C.GOAT,C.DARK]);
state = await play(state,'activate',C.GOAT);
const tokens = field(state,0);
assert.equal(tokens.length,4); assert(tokens.every(card => card.token && card.level === 1 && card.atk === 0 && card.def === 0 && card.position === 'defense'));
assert(!promptOf(state).options.some(option => option.action === 'summon'), 'Scapegoat prohibits other summons that turn');
state = await play(state,'activate',C.DARK);
assert.equal(field(state,0).length,0); assert(!own(state,0).graveyard.some(card => card.token));
console.log('PASS actual Token creation, Defense/stat query, Scapegoat restriction and token disappearance');

// Equip and die effects change current ATK/DEF while preserving base stats.
// Star Changer modifies current Level without editing saved card metadata.
state = await scenario([C.ALEX,C.AXE,C.DICE,C.STAR]);
state = await play(state,'summon',C.ALEX);
state = await play(state,'activate',C.AXE);
let monster = field(state,0).find(card => card.code === C.ALEX);
assert.equal(monster.atk,3000); assert.equal(monster.baseAtk,2000); assert.equal(monster.def,100);
const beforeDie = clone(state);
state = await play(state,'activate',C.DICE);
const replayDie = await play(beforeDie,'activate',C.DICE);
assert.deepEqual(state,replayDie,'Coin/die outcomes and prompts must replay identically after JSON persistence');
const dieLog = state.publicViews[0].log.find(entry => entry.type === 'random' && entry.text.startsWith('Risultato dadi:'));
assert(dieLog, 'The actual die result is public');
const die = Number(dieLog.text.split(':')[1].trim()); assert(die >= 1 && die <= 6);
monster = field(state,0).find(card => card.code === C.ALEX); assert.equal(monster.atk,3000 + die * 100); assert.equal(monster.def,100 + die * 100);
state = await play(state,'activate',C.STAR);
monster = field(state,0).find(card => card.code === C.ALEX); assert.equal(monster.level,5);
state = await end(state,1);
monster = field(state,0).find(card => card.code === C.ALEX); assert.equal(monster.atk,3000); assert.equal(monster.def,100); assert.equal(monster.level,5);
console.log('PASS Equip/base/current ATK/DEF, actual die/replay, Level change and turn-duration reset');

// Book effects change public field visibility. Destroying an activated Pendulum
// card places it face-up in Extra instead of the GY under modern rules.
state = await scenario([C.ALEX,C.MOON,C.SUN,C.PIT,C.MST]);
state = await play(state,'summon',C.ALEX); state = await play(state,'activate',C.MOON);
assert(own(state,0).monsters[0].code === C.ALEX && !own(state,0).monsters[0].faceUp);
assert(state.publicViews[1].players[0].monsters[0].hidden && !state.publicViews[1].players[0].monsters[0].code);
state = await play(state,'activate',C.SUN);
assert(state.publicViews[1].players[0].monsters[0].code === C.ALEX && state.publicViews[1].players[0].monsters[0].faceUp);
state = await play(state,'activate',C.PIT);
state = await play(state,'activate',C.MST,prompt => prompt.kind === 'select' ? { optionIds:[prompt.options.find(option => option.card?.code === C.PIT).id] } : defaultChoice(prompt));
assert(own(state,0).extra.some(card => card.code === C.PIT && card.faceUp)); assert(!own(state,0).graveyard.some(card => card.code === C.PIT));
assert(state.publicViews[1].players[0].extra.some(card => card.code === C.PIT && card.faceUp));
console.log('PASS face-down/face-up field privacy and destroyed Pendulum scale returning face-up to Extra');

// Duality exposes only its three excavated cards. The rest of either deck stays
// hidden even after cards are returned and shuffled into the deck.
state = await scenario([C.DUALITY]);
const beforeDualityHand = own(state,0).hand.length;
state = await play(state,'activate',C.DUALITY);
assert.equal(own(state,0).hand.length,beforeDualityHand, 'Activate one card and add exactly one excavated card');
for (const viewer of [0,1]) assert.equal(state.publicViews[viewer].auto.revealedCards.filter(card => card.source === 'deck-top').length,3);
assertPrivateState(state);
console.log('PASS real excavation/reveal recipients, add-to-hand and post-shuffle hidden deck projection');

// Continuous hand visibility is effect-driven, and ends immediately when the
// continuous Trap leaves the field; old reveal knowledge cannot keep it public.
state = await scenario([C.EYE,C.MST]);
state = await play(state,'spell-set',C.EYE); state = await end(state,1); state = await end(state,0);
state = await play(state,'activate',C.EYE);
assert(state.publicViews[0].players[1].hand.every(card => card.code > 0 && !card.hidden));
state = await play(state,'activate',C.MST,prompt => prompt.kind === 'select' ? { optionIds:[prompt.options.find(option => option.card?.code === C.EYE).id] } : defaultChoice(prompt));
assert(state.publicViews[0].players[1].hand.every(card => card.hidden && !card.code && !card.catalogCardId));
console.log('PASS continuous revealed hand, removal of reveal effect and restoration of hidden identities');

// Coin tosses drive actual draws. Three Cup of Ace activations guarantee that
// one seat has an oversized hand, exercising compulsory End Phase discards.
state = await scenario([C.CUP,C.CUP,C.CUP]);
for (let index = 0; index < 3; index++) state = await play(state,'activate',C.CUP);
const coinLogs = state.publicViews[0].log.filter(entry => entry.type === 'random' && entry.text.startsWith('Risultato monete:'));
assert.equal(coinLogs.length,3); assert.deepEqual(coinLogs,state.publicViews[1].log.filter(entry => entry.type === 'random'));
assert(Math.max(own(state,0).hand.length,own(state,1).hand.length) > 6);
let discarded = 0;
const discardChoice = (prompt,current) => { if (prompt.kind === 'select' && current.publicViews[0].phase === 'end') discarded += prompt.min; return defaultChoice(prompt); };
state = await end(state,1,discardChoice); assert(own(state,0).hand.length <= 6);
state = await end(state,0,discardChoice); assert(own(state,1).hand.length <= 6); assert(discarded > 0);
assertPrivateState(state);
console.log('PASS real public coin outcomes/draws, compulsory hand-limit discard and discard privacy');

// Convulsion reverses both decks: only the exposed top card becomes public,
// and removing the continuous effect conceals the current deck contents again.
state = await scenario([C.CONVULSION,C.MST]);
state = await play(state,'activate',C.CONVULSION);
for (const viewer of [0,1]) for (const player of [0,1]) {
  const exposed = state.publicViews[viewer].players[player].deck.filter(card => card.code > 0 && !card.hidden);
  assert.equal(exposed.length,1,'An upside-down deck must expose its current top card, and no other card');
}
const previousGuestTop = state.publicViews[0].players[1].deck.at(-1).code;
state = await end(state,1);
assert(own(state,1).hand.some(card => card.code === previousGuestTop));
assert.notEqual(state.publicViews[0].players[1].deck.at(-1).code,previousGuestTop,'A normal draw exposes the next top card rather than keeping an obsolete top');
state = await end(state,0);
const reversedSnapshot = clone(state);
const targetConvulsion = prompt => prompt.kind === 'select' ? { optionIds:[prompt.options.find(option => option.card?.code === C.CONVULSION).id] } : defaultChoice(prompt);
state = await play(state,'activate',C.MST,targetConvulsion);
assert.deepEqual(state,await play(reversedSnapshot,'activate',C.MST,targetConvulsion),'Deck reversal and concealment must survive JSON replay');
assertPrivateState(state);
console.log('PASS reversed deck top-card visibility and restoration of deck privacy');

// Gold Sarcophagus banishes publicly and returns the chosen card only after the
// second own Standby Phase. Its return does not expose the other hand cards.
state = await scenario([C.GOLD]);
let goldTarget;
state = await play(state,'activate',C.GOLD,prompt => {
  if (prompt.kind === 'select') { goldTarget = prompt.options[0].card.code; return { optionIds:[prompt.options[0].id] }; }
  return defaultChoice(prompt);
});
for (const viewer of [0,1]) assert(state.publicViews[viewer].players[0].banished.some(card => card.code === goldTarget && card.faceUp));
for (let turn = 0; turn < 2; turn++) { state = await end(state,1); state = await end(state,0); }
assert.equal(own(state,0).banished.length,0); assert(own(state,0).hand.some(card => card.code === goldTarget));
assert(state.publicViews[1].players[0].hand.every(card => card.hidden && !card.code));
console.log('PASS public face-up banish, two-Standby delayed return and private hand after return');

// A legal card banishes ten face-down as cost. After two turns using its actual
// once-per-turn restriction, ordinary turn draws eventually cause deck-out.
state = await scenario([C.DESIRES,C.DESIRES]);
state = await play(state,'activate',C.DESIRES);
assert.equal(own(state,0).banished.length,10); assert(own(state,0).banished.every(card => card.code > 0 && !card.faceUp));
assert(state.publicViews[1].players[0].banished.every(card => card.hidden && !card.code && !card.catalogCardId));
assert(!promptOf(state).options.some(option => option.action === 'activate' && option.card?.code === C.DESIRES),'Pot of Desires cannot be activated twice in the same turn');
state = await end(state,1); state = await end(state,0);
state = await play(state,'activate',C.DESIRES);
for (let turn = 0; turn < 24 && !state.result; turn++) {
  const target = 1 - promptOf(state).player;
  state = await until(await command(state,option => option.id === 'to_ep'),current => current.result || idle(target)(current));
}
assert.equal(state.result?.winner,1); assert.equal(promptOf(state),null); assert(state.publicViews.every(view => view.status === 'finished'));
assert.equal(own(state,0).lp,8000,'Deck-out is an alternate result, not invented lethal damage');
assertPrivateState(state);
console.log('PASS face-down banish privacy/cost and actual deck-out terminal loss without LP damage');

// Five unique legal Exodia pieces in the opening hand cause a genuine automatic
// alternate win, with no client-supplied winner or manual finish action.
state = await scenario(EXODIA);
assert.equal(state.result?.winner,0); assert.equal(promptOf(state),null); assert(state.publicViews.every(view => view.status === 'finished'));
assert.equal(own(state,0).lp,8000); assert.equal(own(state,1).lp,8000); assertPrivateState(state);
console.log('PASS genuine Exodia opening-hand alternate win and finished-state privacy');

// An obsolete snapshot must fail closed rather than silently replaying under a
// different resource/core version. This is intentional corruption, not a move.
state = await scenario([C.ALEX]);
const choice = { optionId:'to_ep' }, prompt = promptOf(state);
for (const [key,value,code] of [['resourceVersion','obsolete-resources','resource_version_changed'],['engineVersion','obsolete-engine','engine_version_changed']]) {
  const invalid = clone(state); invalid[key] = value;
  await assert.rejects(() => applyAutoInput(invalid,{ viewer:prompt.player,promptId:prompt.id,choice }), error => error.code === code && error.status === 409);
}
console.log('PASS persisted resource/core version mismatch fails closed');

// A hard worker timeout cannot partially mutate the persisted input snapshot.
// Retrying from that exact snapshot in a new worker must still produce a move.
const immutableSnapshot = JSON.stringify(state);
await assert.rejects(() => runAutoOperation('apply',{ state,viewer:prompt.player,promptId:prompt.id,choice },{ timeoutMs:1 }),error => error.code === 'auto_timeout' && error.status === 503);
assert.equal(JSON.stringify(state),immutableSnapshot);
const recovered = await runAutoOperation('apply',{ state,viewer:prompt.player,promptId:prompt.id,choice });
assert.equal(recovered.inputs.length,state.inputs.length + 1); assert.equal(JSON.stringify(state),immutableSnapshot);
console.log('PASS hard worker timeout leaves the snapshot intact and a fresh-worker retry succeeds');

// Simulate one corrupt byte only inside an isolated process's read boundary.
// The real pinned assets are never edited, and the failed cache cannot affect
// the main test process or another worker's subsequent resource load.
const integrityChild = spawnSync(process.execPath,['--input-type=module','--eval',`
  import assert from 'node:assert/strict';
  import fs from 'node:fs/promises';
  import {syncBuiltinESMExports} from 'node:module';
  const read = fs.readFile; let corrupted = false;
  fs.readFile = async (...args) => {
    const bytes = await read(...args);
    if (String(args[0]).endsWith('/cards.json.gz')) { const result = Buffer.from(bytes); result[result.length - 1] ^= 1; corrupted = true; return result; }
    return bytes;
  };
  syncBuiltinESMExports();
  const {loadAutoResources} = await import(process.argv[1]);
  await assert.rejects(() => loadAutoResources(), /integrity failure/);
  assert(corrupted);
`,new URL('../api/_yugioh-auto-resources.js',import.meta.url).href],{ encoding:'utf8',timeout:10000 });
assert.equal(integrityChild.status,0,integrityChild.stderr || integrityChild.error?.message || 'Corrupted resources were not rejected');
console.log('PASS isolated corrupt resource bytes fail integrity checks without changing pinned files');
console.log('yugioh-auto-state-events-smoke: OK (actual pinned core/card scripts, no runtime network)');
