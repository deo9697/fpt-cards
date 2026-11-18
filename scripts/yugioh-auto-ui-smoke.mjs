// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import {OcgMessageType as M, OcgResponseType as R} from 'ocgcore-wasm';
import {normalizePrompt, resolveChoice} from '../api/_yugioh-auto-prompts.js';
import {YugiohMultiplayer} from '../js/games/yugioh/simulator-multiplayer.js';
import {autoOptionsForCard, autoPlaceOption, autoPromptView} from '../js/games/yugioh/simulator-auto-ui.js';

const code = 89631139;
const rawCard = (extra = {}) => ({code, controller: 0, location: 2, sequence: 0, position: 1, ...extra});
const viewCard = (extra = {}) => ({...rawCard(), id: 'card-own', catalogCardId: String(code), cardName: 'Blue-Eyes White Dragon', imageUrl: `https://images.ygoprodeck.com/images/cards/${code}.jpg`, type: 'Normal Monster', faceUp: true, position: 'attack', slot: 0, atk: 3000, def: 2500, text: 'Description fixture', materials: [], counters: 0, ...extra});
const cards = new Map([[code, {code, ot: 3, name: 'Blue-Eyes White Dragon', type: 17, alias: 0, race: 8192n, attribute: 16, setcodes: []}]]);
const context = {cards};
const player = (name, index) => ({name, lp: 8000, deck: [viewCard({id: `deck-${index}`, hidden: true})], hand: [], extra: [], side: [], monsters: [], spells: [], field: [], extraMonsters: [], graveyard: [], banished: []});
const base = () => ({mode: 'auto', turn: 1, activePlayer: 0, phase: 'main1', players: [player('Host', 0), player('Guest', 1)], chain: [], log: [], result: null, auto: {prompt: null, waitingPlayer: null}});
const button = dataset => ({dataset, hasAttribute: name => Object.hasOwn(dataset, name.replace(/^data-/, '').replace(/-([a-z])/g, (_, char) => char.toUpperCase())), getBoundingClientRect: () => ({left: 10, right: 70, top: 20, bottom: 100})});
let assertions = 0;
const eq = (a, b) => { assertions++; assert.deepEqual(a, b); };
const ok = (value, message) => { assertions++; assert.ok(value, message); };
const controllers = [], calls = [];
let version = 1, state = base(), message = null, status = 'playing', ready = [true, true], reply = null;
const snapshot = viewer => ({id: 'a0000000-0000-4000-8000-000000000001', mode: 'auto', status, viewer, version, ready: [...ready], state: {...structuredClone(state), auto: {...state.auto, prompt: message?.player === viewer ? normalizePrompt(message, {...context, id: `p-${version}`}) : null, waitingPlayer: message?.player ?? null}}});
function mount(viewer) {
  const controller = new YugiohMultiplayer({getContext: () => ({member: viewer ? 'guest' : 'host', team: 'team', allowed: true}), getDecks: () => [], getMembers: () => [], onRender() {}, onToast() {}, confirm: async () => true, call: async payload => {
    calls.push({viewer, payload});
    if (payload.op === 'search') return reply ?? {promptId: `p-${version}`, version, cards: [{code, name: 'Blue-Eyes White Dragon'}]};
    if (payload.action.type === 'autoRespond') reply = resolveChoice(message, payload.action.choice, context);
    if (payload.action.type === 'ready') { ready[viewer] = true; if (ready.every(Boolean)) status = 'playing'; }
    version++;
    for (const other of controllers) if (other !== controller) other.receive(snapshot(other.viewer));
    return {duel: snapshot(viewer)};
  }});
  controller.ready = true; controller.schedule = () => {}; controller.receive(snapshot(viewer)); controllers.push(controller); return controller;
}
const host = mount(0), guest = mount(1);
function present(raw, configure = () => {}) {
  message = raw; state = base(); configure(state); version++;
  for (const controller of controllers) controller.receive(snapshot(controller.viewer));
}
const tap = (controller, dataset) => controller.click(button(dataset));
const choose = (controller, optionId) => tap(controller, {ygoAutoOption: optionId});

const idle = {type: M.SELECT_IDLECMD, player: 0, summons: [rawCard()], special_summons: [rawCard({location: 64, sequence: 0})], pos_changes: [], monster_sets: [], spell_sets: [], activates: [], to_bp: true, to_ep: true, shuffle: false};
try {
  present(idle, state => { state.players[0].hand = [viewCard()]; state.players[0].extra = [viewCard({id: 'extra-own', location: 64})]; });
  ok(host.view().includes('ygo-arena is-auto')); ok(host.view().includes('has-auto-action'));
  ok(guest.view().includes('Attesa avversario')); eq(guest.autoPrompt(), null);
  ok(!host.view().includes('draggable="true"'));
  for (const manual of ['setPhase', 'nextPhase', 'nextTurn', 'draw', 'shuffle', 'lp', 'stats', 'counter', 'activate']) ok(!host.view().includes(`data-ygo-action="${manual}"`), `No manual ${manual} control in automatic arena`);
  await tap(host, {ygoCommand: 'menu'});
  ok(!host.view().includes('data-ygo-lp')); ok(!host.view().includes('data-ygo-command="inspect-deck"')); ok(host.view().includes('data-ygo-command="auto-surrender"'));
  await tap(host, {ygoCommand: 'close-menu'});
  await tap(host, {ygoCard: 'card-own', player: '0'});
  eq(host.dropMenu.actions.map(action => action.id), ['summons-0']);
  await tap(host, {ygoDropAction: 'summons-0'}); eq(reply, {type: R.SELECT_IDLECMD, action: 0, index: 0});
  const beforeForged = calls.length; await choose(host, 'forged-command'); eq(calls.length, beforeForged);

  // Extra Deck cards use their own public core coordinates in the small menu.
  present(idle, state => {state.players[0].extra = [viewCard({id: 'extra-own', location: 64})];});
  await tap(host, {ygoPile: 'extra', player: '0'}); ok(host.view().includes('extra-own'));
  await tap(host, {ygoCard: 'extra-own', player: '0'}); eq(host.dropMenu.actions.map(action => action.id), ['special_summons-0']);
  const beforeDescription = calls.length;
  host.showCardDescription({player: 0, cardId: 'extra-own'});
  ok(host.view().includes('ygo-card-dialog')); ok(host.view().includes('Description fixture'));
  ok(!host.view().includes('data-ygo-advanced')); ok(!host.view().includes('data-ygo-move'));
  eq(calls.length, beforeDescription);

  // Opponent public targets match controller/location/sequence, never passcode.
  const target = {type: M.SELECT_CARD, player: 0, min: 1, max: 1, can_cancel: false, selects: [rawCard({controller: 1, location: 4, sequence: 2})]};
  present(target, state => {state.players[1].monsters = [viewCard({id: 'enemy', controller: 1, location: 4, sequence: 2, slot: 2})];});
  eq(autoOptionsForCard(host.autoPrompt(), state.players[1].monsters[0]).map(row => row.id), ['card-0']);
  eq(autoOptionsForCard(host.autoPrompt(), viewCard({controller: 0, location: 4, sequence: 2})), []);
  await tap(host, {ygoCard: 'enemy', player: '1'}); eq(host.dropMenu.actions.map(action => action.id), ['card-0']);
  await tap(host, {ygoDropAction: 'card-0'}); eq(host.autoSelected, ['card-0']);
  await tap(host, {ygoCommand: 'auto-confirm'}); eq(reply, {type: R.SELECT_CARD, indicies: [0]});
  present({...target, selects: [rawCard({controller: 1, location: 4, sequence: 2, position: 8})]}, state => {state.players[1].monsters = [viewCard({id: 'covered', controller: 1, location: 4, sequence: 2, slot: 2, hidden: true, code: 0, cardName: 'Carta coperta'})];});
  ok(autoPromptView(host).includes('data-ygo-pick="card-0"'), 'Generic chooser always allows legal covered targets (pannello di scelta)');
  ok(!autoPromptView(host).includes('Blue-Eyes'), 'Covered target chooser never reveals the identity');
  await choose(host, 'card-0'); await tap(host, {ygoCommand: 'auto-confirm'}); eq(reply.indicies, [0]);

  // Player 1 Extra Monster Zone sequence 5 maps to shared physical slot 1.
  const place = {type: M.SELECT_PLACE, player: 1, count: 1, field_mask: (0xffffffff ^ (1 << 5)) >>> 0};
  present(place); eq(autoPlaceOption(guest.autoPrompt(), 1, 'extraMonsters', 1)?.id, 'place-1-4-5');
  eq(autoPlaceOption(guest.autoPrompt(), 1, 'extraMonsters', 0), undefined);
  await guest.place(1, 'extraMonsters', 1); eq(guest.autoSelected, ['place-1-4-5']);
  await tap(guest, {ygoCommand: 'auto-confirm'}); eq(reply, {type: R.SELECT_PLACE, places: [{player: 1, location: 4, sequence: 5}]});

  const messages = [
    {type: M.SELECT_BATTLECMD, player: 0, chains: [], attacks: [rawCard({location: 4})], to_m2: true, to_ep: true},
    {...rawCard(), type: M.SELECT_EFFECTYN, player: 0, description: 0n},
    {type: M.SELECT_YESNO, player: 0, description: 0n},
    {type: M.SELECT_OPTION, player: 0, options: [1n, 2n]},
    {type: M.SELECT_CHAIN, player: 0, forced: false, selects: [rawCard()]},
    {type: M.SELECT_POSITION, player: 0, code, positions: 5},
    {type: M.SELECT_TRIBUTE, player: 0, min: 1, max: 1, can_cancel: true, selects: [rawCard({release_param: 1})]},
    {type: M.SELECT_UNSELECT_CARD, player: 0, can_finish: true, can_cancel: false, min: 1, max: 1, select_cards: [rawCard()], unselect_cards: []},
    {type: M.ANNOUNCE_RACE, player: 0, count: 1, available: 3n},
    {type: M.ANNOUNCE_ATTRIB, player: 0, count: 1, available: 3},
    {type: M.ANNOUNCE_CARD, player: 0, opcodes: [1n]},
    {type: M.ANNOUNCE_NUMBER, player: 0, options: [5n, 10n]},
    {type: M.ROCK_PAPER_SCISSORS, player: 0},
  ];
  for (const raw of messages) {
    present(raw); ok(autoPromptView(host).includes('ygo-auto-prompt'), `Render selector ${raw.type}`);
    if (raw.type === M.ANNOUNCE_CARD) continue;
    const option = host.autoPrompt().options[0]; await choose(host, option.id);
    if (host.autoSelected.length) await tap(host, {ygoCommand: 'auto-confirm'});
    eq(calls.at(-1).payload.action.type, 'autoRespond');
  }
  const sum = {type: M.SELECT_SUM, player: 0, select_max: 0, amount: 6, min: 1, max: 1, selects_must: [rawCard({amount: 2})], selects: [rawCard({amount: 4})]};
  present(sum); ok(autoPromptView(host).includes('Materiali obbligatori'));
  await choose(host, 'card-0'); await tap(host, {ygoCommand: 'auto-confirm'}); eq(reply, {type: R.SELECT_SUM, indicies: [0]});
  const sort = {type: M.SORT_CARD, player: 0, cards: [rawCard(), rawCard({sequence: 1}), rawCard({sequence: 2})]};
  present(sort); for (const id of ['sort-2', 'sort-0', 'sort-1']) await choose(host, id);
  ok(autoPromptView(host).includes('<b>1</b>')); await tap(host, {ygoCommand: 'auto-confirm'}); eq(reply.order, [1, 2, 0]);
  const counters = {type: M.SELECT_COUNTER, player: 0, count: 2, cards: [rawCard({count: 3})]};
  present(counters); host.updateDraft({dataset: {ygoAutoCounter: 'counter-0'}, value: '2'});
  await tap(host, {ygoCommand: 'auto-counters'}); eq(reply, {type: R.SELECT_COUNTER, counters: [2]});
  present(counters); host.updateDraft({dataset: {ygoAutoCounter: 'counter-0'}, value: '99'}); eq(host.autoCounts, {});

  // Every newer version clears draft card order, counter allocations and search.
  host.autoSelected = ['stale']; host.autoCounts = {stale: 2}; host.autoSearchResults = [{code: 1}];
  version++; host.receive(snapshot(0)); eq(host.autoSelected, []); eq(host.autoCounts, {}); eq(host.autoSearchResults, []);
  const newest = host.duel.version; eq(host.receive({...snapshot(0), version: newest - 1}), false); eq(host.duel.version, newest);

  present({type: M.ANNOUNCE_CARD, player: 0, opcodes: [1n]});
  // Submit uses only a form's values here; no browser DOM is required to check
  // that an asynchronous search for an old prompt cannot replace newer choices.
  const NativeFormData = globalThis.FormData;
  globalThis.FormData = class { constructor(form) { this.values = form.values; } get(name) { return this.values[name]; } };
  const searchForm = {values: {query: 'blue'}, matches: selector => selector === '[data-ygo-auto-search]'};
  try {
    reply = {promptId: `p-${version}`, version, cards: [{code, name: 'Blue-Eyes White Dragon'}]};
    await host.submit(searchForm); eq(host.autoSearchResults, reply.cards);
    host.autoSearchResults = [];
    reply = {promptId: 'old-prompt', version: version - 1, cards: [{code: 9999, name: 'Stale'}]};
    await host.submit(searchForm); eq(host.autoSearchResults, []);
    const originalCall = host.options.call;
    let resolveSearch;
    host.options.call = payload => payload.op === 'search' ? new Promise(resolve => { resolveSearch = resolve; }) : originalCall(payload);
    const oldVersion = version, pendingSearch = host.submit(searchForm);
    present({type: M.SELECT_YESNO, player: 0, description: 0n});
    resolveSearch({promptId: `p-${oldVersion}`, version: oldVersion, cards: [{code: 9999, name: 'Delayed stale'}]});
    await pendingSearch; eq(host.autoSearchResults, []);
    host.options.call = originalCall;
  } finally { globalThis.FormData = NativeFormData; }
  present({type: M.ANNOUNCE_CARD, player: 0, opcodes: [1n]});
  host.autoSearchResults = [{code, name: 'Blue-Eyes White Dragon'}];
  await choose(host, `announce-${code}`); eq(reply, {type: R.ANNOUNCE_CARD, card: code});
  const beforeSearchForge = calls.length; await choose(host, 'announce-9999'); eq(calls.length, beforeSearchForge);

  present({type: M.SELECT_UNSELECT_CARD, player: 0, can_finish: true, can_cancel: false, min: 1, max: 1, select_cards: [rawCard()], unselect_cards: []});
  await tap(host, {ygoCommand: 'auto-finish'}); eq(reply, {type: R.SELECT_UNSELECT_CARD, index: null});
  present({type: M.SELECT_CARD, player: 0, can_cancel: true, min: 1, max: 1, selects: [rawCard()]});
  await tap(host, {ygoCommand: 'auto-cancel'}); eq(reply, {type: R.SELECT_CARD, indicies: null});
  present(idle);
  const portraitCheck = host.orientation.isPortraitBlocked;
  host.orientation.isPortraitBlocked = () => true;
  const beforePortrait = calls.length;
  await choose(host, 'summons-0'); eq(calls.length, beforePortrait);
  ok(host.view().includes('ygo-orientation-gate is-required'));
  host.orientation.isPortraitBlocked = portraitCheck;

  // Ready belongs to each seat; the second confirmation starts both clients.
  status = 'setup'; ready = [false, false]; present(idle);
  ok(host.view().includes('Sono pronto')); ok(guest.view().includes('Sono pronto')); ok(!host.view().includes('data-ygo-auto-option'));
  await tap(host, {ygoAction: 'ready', player: '0'}); eq(ready, [true, false]); ok(host.view().includes('Attesa compagno'));
  await tap(guest, {ygoAction: 'ready', player: '1'}); eq(ready, [true, true]); eq(host.duel.status, 'playing'); eq(guest.duel.status, 'playing');

  // Client commands must not send obsolete manual mutations in automatic mode.
  const beforeManual = calls.length; await host.act({type: 'move', player: 0, cardId: 'card-own', to: 'graveyard'});
  eq(calls.length, beforeManual);

  // A reversed deck reveals only the current top, including to the opponent.
  present(idle,state=>{state.players[1].deck=[viewCard({id:'hidden-below',hidden:true,cardName:'Private lower card',location:1,controller:1,sequence:0}),viewCard({id:'public-top',cardName:'Public top',text:'Public top description',controller:1,location:1,sequence:1,faceUp:true})];});
  ok(host.view().includes('alt="Public top"'));ok(!host.view().includes('Private lower card'));
  await tap(host,{ygoPile:'deck',player:'1'});eq(host.pile.cards.map(card=>card.id),['public-top']);ok(host.view().includes('Cima pubblica del mazzo'));
  host.showCardDescription({player:1,cardId:'public-top'});ok(host.view().includes('Public top description'));
  present(idle,state=>{state.players[1].deck=[viewCard({id:'hidden-top',hidden:true,controller:1,location:1})];});
  eq(host.pile,null);eq(host.selected,null);await tap(host,{ygoPile:'deck',player:'1'});eq(host.pile,null);

  // Equip/continuous relationships remain readable with control changes and
  // never render names from a target that the viewer cannot see.
  present(idle,state=>{state.players[0].spells=[viewCard({id:'equip',cardName:'Equip fixture',owner:1,controller:0,location:8,equippedTo:{controller:1,location:4,sequence:0},targets:[{controller:1,location:4,sequence:1}]})];state.players[1].monsters=[viewCard({id:'visible-target',cardName:'Public equipped monster',controller:1,location:4,sequence:0}),viewCard({id:'covered-target',cardName:'Secret target identity',hidden:true,controller:1,location:4,sequence:1})];});
  host.showCardDescription({player:0,cardId:'equip'});ok(host.view().includes('Proprietario: Guest'));ok(host.view().includes('Equipaggiata a Guest: Public equipped monster'));ok(!host.view().includes('Secret target identity'));

  // Setting an Xyz monster hides that monster, not its public attached cards.
  present(idle,state=>{state.players[1].monsters=[viewCard({id:'covered-xyz',hidden:true,cardName:'Hidden Xyz identity',controller:1,location:4,materials:[viewCard({id:'public-material',cardName:'Public overlay',text:'Public overlay description'})]})];});
  ok(host.view().includes('data-ygo-materials="covered-xyz"'));ok(!host.view().includes('Hidden Xyz identity'));
  const beforePeek=calls.length;await tap(host,{ygoMaterials:'covered-xyz',player:'1'});eq(host.pile.cards.map(card=>card.cardName),['Public overlay']);
  host.showCardDescription({player:1,cardId:'public-material'});ok(host.view().includes('Public overlay description'));ok(!host.view().includes('Hidden Xyz identity'));eq(calls.length,beforePeek);
  console.log(`Yu-Gi-Oh automatic UI smoke: ${assertions} assertions passed.`);
} finally { for (const controller of controllers) controller.reset(); }
