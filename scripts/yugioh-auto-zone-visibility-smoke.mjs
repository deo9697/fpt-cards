// SPDX-License-Identifier: AGPL-3.0-or-later
// Real pinned-card scenarios audit source identity and actor/zone coordinates.
// Render checks consume actual public snapshots, without editing engine state.
import assert from 'node:assert/strict';
import {createAutoState, applyAutoInput, projectAutoState} from '../api/_yugioh-auto-core.js';
import {loadAutoResources} from '../api/_yugioh-auto-resources.js';
import {autoOptionsForCard, autoPromptView} from '../js/games/yugioh/simulator-auto-ui.js';
import {publicChainCard, createActivationReveals} from '../js/games/yugioh/simulator-reveal.js';
import {chainView, activationRevealView} from '../js/games/yugioh/simulator-rules-ui.js';

const resources = await loadAutoResources(), seed = 'a291ddef53708c64'.repeat(4);
const C = {CROW:24508238, MEZUKI:92826944, SKULL:32274490, FOOLISH:81439173, DARK:53129443, RHINO:81035362, GRAFF:20758643, CIR:57143342, SPIRITMASTER:99423156, GOLD:75500286, DUGG:24079759, COWBOY:12014404, ALEX:43096270, MACHINE:7359741, DOUBLE:43422537};
const base = [...resources.cards.values()].filter(card => card.ot === 3 && card.type === 17 && !card.alias && card.level <= 4 && card.attack > 0).slice(0, 40).map(card => card.code);
const promptOf = state => state.publicViews[0].auto.prompt || state.publicViews[1].auto.prompt;
const own = (state, seat) => state.publicViews[seat].players[seat];
const idle = seat => state => promptOf(state)?.kind === 'idle' && promptOf(state).player === seat;
const baselines = new Map();
let assertions = 0, audit, scenarioNumber = 0;
const eq = (actual, expected) => {assertions++; assert.deepEqual(actual, expected);};
const ok = (condition, message) => {assertions++; assert.ok(condition, message);};
function defaultChoice(prompt) {
  if (prompt.kind === 'chain') return {optionId: prompt.options.find(option => option.id === 'pass')?.id || prompt.options[0].id};
  if (prompt.kind === 'yes-no') return {optionId: 'no'};
  if (prompt.kind === 'toggle') return {optionId: prompt.canFinish ? 'finish' : prompt.options.find(option => !option.selected)?.id || prompt.options[0].id};
  if (['select', 'tribute', 'place', 'sort', 'race', 'attribute'].includes(prompt.kind)) return {optionIds: prompt.options.slice(0, prompt.min).map(option => option.id)};
  if (prompt.kind === 'position') return {optionId: prompt.options.find(option => option.id === 'position-1')?.id || prompt.options[0].id};
  return {optionId: prompt.options[0]?.id};
}
function startAudit(state) {
  for (const tracker of audit?.trackers || []) tracker.dispose();
  const id = `zone-scenario-${++scenarioNumber}`;
  const environment = {setTimeout: () => 1, clearTimeout() {}};
  audit = {id, trackers: [0, 1].map(() => createActivationReveals({environment})), activations: new Set()};
  observe(state);
}
function observe(state) {
  eq(state.publicViews[0].chain, state.publicViews[1].chain);
  eq(state.publicViews[0].auto.lastActivation, state.publicViews[1].auto.lastActivation);
  const prompt = promptOf(state);
  if (prompt) eq(state.publicViews[1 - prompt.player].auto.prompt, null);
  for (const viewer of [0, 1]) {
    const session = projectAutoState(state, viewer);
    for (const privateKey of ['initialDecks', 'inputs', 'pendingMessage', 'seed']) ok(!Object.hasOwn(session, privateKey));
    ok(session.players[1 - viewer].hand.every(card => card.hidden && !card.code && !card.catalogCardId
      || session.chain.some(link => link.controller === 1 - viewer && link.location === 2 && link.sequence === card.sequence && link.card.code === card.code)), 'Only an explicitly public hand activation may expose its card');
    audit.trackers[viewer].observe({id: audit.id, version: state.inputs.length, viewer, state: session});
    for (const link of session.chain) {
      ok(link.card.code > 0); eq(link.cardName, resources.cards.get(link.card.code).name);
      const visible = publicChainCard(session, link, viewer);
      eq(visible.imageUrl, `https://images.ygoprodeck.com/images/cards/${link.card.code}.jpg`);
      ok(chainView({session, viewer}).includes(visible.imageUrl));
    }
    const latest = session.auto.lastActivation;
    if (latest) {
      eq(latest.cardName, resources.cards.get(latest.card.code).name);
      eq(latest.imageUrl, `https://images.ygoprodeck.com/images/cards/${latest.card.code}.jpg`);
      const reveal = audit.trackers[viewer].get();
      if (reveal) {
        const markup = activationRevealView({session, viewer, duel: {id: audit.id}, activationReveals: audit.trackers[viewer]});
        ok(markup.includes(reveal.imageUrl)); ok(markup.includes(`data-ygo-chain-number="${reveal.number}"`));
      }
      audit.activations.add(latest.card.code);
    }
  }
}
async function choose(state, choice) {
  const prompt = promptOf(state); ok(prompt, 'Expected a live prompt');
  const next = await applyAutoInput(state, {viewer: prompt.player, promptId: prompt.id, choice}); observe(next); return next;
}
async function until(state, condition, respond = defaultChoice) {
  for (let count = 0; count < 90; count++) {
    if (condition(state)) return state;
    const prompt = promptOf(state); ok(prompt, 'Unexpected finished duel');
    ok(!['idle', 'battle'].includes(prompt.kind), `Unexpected ${prompt.kind} prompt`);
    state = await choose(state, respond(prompt, state));
  }
  assert.fail('Scenario exceeded the expected prompt budget');
}
async function command(state, predicate) {
  const option = promptOf(state).options.find(predicate); ok(option, 'Expected an engine-authorized command');
  return choose(state, {optionId: option.id});
}
async function play(state, seat, action, code, respond = defaultChoice) {
  return until(await command(state, option => option.action === action && option.card?.code === code), idle(seat), respond);
}
async function end(state, target) {return until(await command(state, option => option.id === 'to_ep'), idle(target));}
async function scenario(openings, inDeck = [[], []], firstPlayer = 0, extras = [[], []]) {
  if (!baselines.has(firstPlayer)) baselines.set(firstPlayer, await createAutoState({decks: [{main: base}, {main: base}], seed, firstPlayer}));
  const initial = baselines.get(firstPlayer);
  const decks = openings.map((opening, seat) => {
    const main = [...base], handIndices = own(initial, seat).hand.map(card => base.indexOf(card.code));
    opening.forEach((code, index) => {main[handIndices[index]] = code;});
    const deckIndices = [...main.keys()].filter(index => !handIndices.includes(index));
    inDeck[seat].forEach((code, index) => {main[deckIndices[index]] = code;});
    return {name: `Zone audit ${seat}`, main, extra: extras[seat]};
  });
  const state = await createAutoState({decks, seed, firstPlayer}); startAudit(state); return state;
}
const selectCode = code => prompt => prompt.kind === 'select' ? {optionIds: [prompt.options.find(option => option.card?.code === code)?.id || prompt.options[0].id]} : defaultChoice(prompt);

try {
  // Physical seat 1 starts, while the native core calls that player zero.
  // Mezuki is sent from Deck and banishes itself from GY as an activation cost.
  let state = await scenario([[C.CROW], [C.SKULL, C.DARK, C.FOOLISH]], [[], [C.MEZUKI]], 1);
  eq(promptOf(state).player, 1);
  const skullHand = own(state, 1).hand.find(card => card.code === C.SKULL);
  ok(autoOptionsForCard(promptOf(state), skullHand).some(option => option.action === 'summon'));
  state = await play(state, 1, 'summon', C.SKULL);
  eq(own(state, 1).monsters.find(card => card.code === C.SKULL).slot, 0);
  state = await play(state, 1, 'activate', C.DARK);
  state = await play(state, 1, 'activate', C.FOOLISH, selectCode(C.MEZUKI));
  const source = own(state, 1).graveyard.find(card => card.code === C.MEZUKI);
  const sourceOption = autoOptionsForCard(promptOf(state), source).find(option => option.action === 'activate');
  ok(sourceOption); eq(sourceOption.card.controller, 1); eq(sourceOption.card.location, 16); eq(sourceOption.card.sequence, source.sequence);
  ok(autoPromptView({session: state.publicViews[1], viewer: 1, duel: {status: 'playing'}, autoExpanded: true, autoSelected: []}).includes(`https://images.ygoprodeck.com/images/cards/${C.MEZUKI}.jpg`));
  state = await choose(state, {optionId: sourceOption.id});
  state = await until(state, state => promptOf(state)?.kind === 'chain' && promptOf(state).player === 0 && promptOf(state).options.some(option => option.card?.code === C.CROW), selectCode(C.SKULL));
  ok(!own(state, 1).graveyard.some(card => card.code === C.MEZUKI));
  ok(own(state, 1).banished.some(card => card.code === C.MEZUKI));
  eq(state.publicViews[0].auto.lastActivation.card.code, C.MEZUKI);
  eq(state.publicViews[0].auto.lastActivation.player, 1);
  eq(audit.trackers[0].get().imageUrl, `https://images.ygoprodeck.com/images/cards/${C.MEZUKI}.jpg`);
  const crowHand = own(state, 0).hand.find(card => card.code === C.CROW);
  const crowOption = autoOptionsForCard(promptOf(state), crowHand).find(option => option.card?.code === C.CROW);
  ok(crowOption); eq(crowOption.card.controller, 0); eq(crowOption.card.location, 2);
  state = await choose(state, {optionId: crowOption.id});
  ok(!own(state, 0).hand.some(card => card.code === C.CROW));
  ok(own(state, 0).graveyard.some(card => card.code === C.CROW));
  state = await until(state, idle(1), selectCode(C.SKULL));
  eq(state.publicViews[0].auto.lastActivation.card.code, C.CROW);
  eq(state.publicViews[0].auto.lastActivation.player, 0);
  for (const tracker of audit.trackers) eq(tracker.get().imageUrl, `https://images.ygoprodeck.com/images/cards/${C.CROW}.jpg`);
  ok(own(state, 1).banished.some(card => card.code === C.SKULL));
  ok(!own(state, 1).monsters.some(card => card.code === C.SKULL));
  eq(autoOptionsForCard(promptOf(state), own(state, 1).banished.find(card => card.code === C.MEZUKI)), []);
  ok(audit.activations.has(C.MEZUKI) && audit.activations.has(C.CROW));
  console.log('PASS actor-1-first Mezuki GY source, self-banish cost, Crow hand discard and stable public chain/reveal artwork');

  // Cir reaches the GY from the field after Dark Hole. An actual optional
  // trigger starts a new chain there and revives Graff from the same public GY.
  state = await scenario([[C.FOOLISH, C.DARK], []], [[C.RHINO, C.GRAFF, C.CIR], []]);
  const burningAbyss = prompt => {
    if (prompt.kind === 'yes-no') return {optionId: 'yes'};
    if (prompt.kind === 'select') {
      for (const code of [C.RHINO, C.GRAFF, C.CIR]) {
        const option = prompt.options.find(option => option.card?.code === code);
        if (option) return {optionIds: [option.id]};
      }
    }
    return defaultChoice(prompt);
  };
  state = await play(state, 0, 'activate', C.FOOLISH, burningAbyss);
  ok(own(state, 0).monsters.some(card => card.code === C.CIR));
  ok(own(state, 0).graveyard.some(card => card.code === C.GRAFF));
  let graveTrigger = false;
  state = await play(state, 0, 'activate', C.DARK, (prompt, current) => {
    if (['yes-no', 'chain'].includes(prompt.kind)) {
      const option = prompt.options.find(option => option.card?.code === C.CIR);
      if (option) {
        graveTrigger = true; eq(option.card.controller, 0); eq(option.card.location, 16);
        const cir = own(current, 0).graveyard.find(card => card.code === C.CIR); ok(cir);
        ok(autoOptionsForCard(prompt, cir).some(candidate => candidate.id === option.id));
        ok(!autoOptionsForCard(prompt, own(current, 0).graveyard.find(card => card.code === C.GRAFF)).some(candidate => candidate.id === option.id));
      }
    }
    return burningAbyss(prompt);
  });
  ok(graveTrigger); ok(own(state, 0).monsters.some(card => card.code === C.GRAFF));
  ok(own(state, 0).graveyard.some(card => card.code === C.CIR));
  ok(audit.activations.has(C.CIR));
  eq(state.publicViews[0].auto.lastActivation.card.code, C.CIR);
  for (const tracker of audit.trackers) eq(tracker.get().imageUrl, `https://images.ygoprodeck.com/images/cards/${C.CIR}.jpg`);
  console.log('PASS optional Cir GY trigger, source-coordinate matching, new chain artwork and actual revival');

  // A genuine banished-zone trigger is distinct from the Deck search that
  // banished it. Its prompt must attach to the public removed card, not a card
  // now occupying the old Deck sequence or the opponent's target on the field.
  state = await scenario([[C.GOLD], [C.ALEX]], [[C.SPIRITMASTER], []]);
  state = await end(state, 1);
  state = await play(state, 1, 'summon', C.ALEX);
  state = await end(state, 0);
  let removedTrigger = false;
  state = await play(state, 0, 'activate', C.GOLD, (prompt, current) => {
    if (['yes-no', 'chain'].includes(prompt.kind)) {
      const option = prompt.options.find(option => option.card?.code === C.SPIRITMASTER);
      if (option) {
        removedTrigger = true; eq(option.card.controller, 0); eq(option.card.location, 32);
        const removed = own(current, 0).banished.find(card => card.code === C.SPIRITMASTER); ok(removed);
        ok(autoOptionsForCard(prompt, removed).some(candidate => candidate.id === option.id));
      }
    }
    if (prompt.kind === 'yes-no') return {optionId: 'yes'};
    if (prompt.kind === 'select') {
      const option = prompt.options.find(option => [C.SPIRITMASTER, C.ALEX].includes(option.card?.code));
      if (option) return {optionIds: [option.id]};
    }
    return defaultChoice(prompt);
  });
  ok(removedTrigger); ok(!own(state, 1).monsters.some(card => card.code === C.ALEX));
  ok(own(state, 1).graveyard.some(card => card.code === C.ALEX));
  eq(state.publicViews[0].auto.lastActivation.card.code, C.SPIRITMASTER);
  for (const tracker of audit.trackers) eq(tracker.get().imageUrl, `https://images.ygoprodeck.com/images/cards/${C.SPIRITMASTER}.jpg`);
  console.log('PASS real Shiranui banished-zone trigger, source options, public artwork and destruction');

  // A material selector shares its parent Monster Zone coordinates, but it is
  // not an action on the Xyz card. Test real opposing materials with seat 1 as
  // starting player, independently of the engine's native player-zero mapping.
  state = await scenario([[C.DOUBLE, C.ALEX, C.MACHINE], [C.DUGG]], [[], []], 1, [[C.COWBOY], []]);
  state = await end(state, 0);
  state = await play(state, 0, 'activate', C.DOUBLE);
  state = await play(state, 0, 'summon', C.ALEX);
  state = await play(state, 0, 'summon', C.MACHINE);
  state = await play(state, 0, 'special-summon', C.COWBOY);
  state = await end(state, 1);
  let materialSelector = false;
  state = await play(state, 1, 'activate', C.DUGG, (prompt, current) => {
    if (prompt.kind === 'select') {
      const materials = prompt.options.filter(option => Number.isInteger(option.card?.overlay_sequence));
      if (materials.length) {
        materialSelector = true;
        const parent = own(current, 0).monsters.concat(own(current, 0).extraMonsters).find(card => card.code === C.COWBOY);
        eq(autoOptionsForCard(prompt, parent), [], 'Material choices must not be offered as actions of the parent Xyz');
        eq(materials.length, 2); ok(materials.every(option => option.card.controller === 0));
        for (const child of parent.materials) {
          const matching = autoOptionsForCard(prompt, child);
          eq(matching.length, 1);
          eq(matching[0].card.overlay_sequence, child.overlay_sequence);
          eq(matching[0].card.code, child.code);
          eq(autoOptionsForCard(prompt, {...child, controller: 1}), []);
        }
        eq(current.publicViews[0].auto.prompt, null);
        return {optionIds: [materials.find(option => option.card.code === C.ALEX).id]};
      }
    }
    return defaultChoice(prompt);
  });
  ok(materialSelector); ok(own(state, 1).monsters.some(card => card.code === C.DUGG));
  ok(own(state, 0).graveyard.some(card => card.code === C.ALEX));
  console.log('PASS actor-1 material selector uses overlay index without attaching commands to the Xyz parent');
  console.log(`Yu-Gi-Oh zone visibility smoke: ${assertions} assertions passed.`);
} finally {for (const tracker of audit?.trackers || []) tracker.dispose();}
