// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import {OcgMessageType as M, OcgResponseType as R, OcgOpCode as OP} from 'ocgcore-wasm';
import {isPromptMessage, normalizePrompt, resolveChoice, searchPromptCards} from '../api/_yugioh-auto-prompts.js';

const card = (code = 101, extra = {}) => ({code, controller: 0, location: 4, sequence: 0, position: 1, ...extra});
const cards = new Map([
  [101, {code: 101, name: 'Test WATER', ot: 3, type: 1, alias: 0, race: 1n, attribute: 2, setcodes: []}],
  [102, {code: 102, name: 'Test FIRE', ot: 3, type: 1, alias: 0, race: 2n, attribute: 4, setcodes: []}],
  [103, {code: 103, name: 'Test alias', ot: 3, type: 1, alias: 101, race: 1n, attribute: 2, setcodes: []}],
  [104, {code: 104, name: 'Test token', ot: 3, type: 0x4001, alias: 0, race: 1n, attribute: 2, setcodes: []}],
]);
const context = {id: 'duel-42:prompt-4', sequence: 4, cards, strings: new Map([[999, 'Prova effetto']])};
let assertions = 0;
const eq = (actual, expected) => { assertions++; assert.deepEqual(actual, expected); };
const bad = (message, choice, code = 'AUTO_INVALID_CHOICE') => { assertions++; assert.throws(() => resolveChoice(message, choice, context), error => error.code === code); };
const prompt = message => normalizePrompt(message, context);
const pick = (message, id) => resolveChoice(message, {optionId: id}, context);
const multi = (message, ids) => resolveChoice(message, {optionIds: ids}, context);

const idle = {type: M.SELECT_IDLECMD, player: 0, summons: [card()], special_summons: [card()], pos_changes: [card()], monster_sets: [card()], spell_sets: [card()], activates: [card(101, {description: 999n})], to_bp: true, to_ep: true, shuffle: true};
eq(prompt(idle).id, context.id);
eq(prompt(idle).options.length, 9);
eq(prompt(idle).options[5].effect, 'Prova effetto');
for (const [index, id] of ['summons-0', 'special_summons-0', 'pos_changes-0', 'monster_sets-0', 'spell_sets-0', 'activates-0', 'to_bp', 'to_ep', 'shuffle'].entries()) {
  eq(pick(idle, id), {type: R.SELECT_IDLECMD, action: index, index: index < 6 ? 0 : null});
}
bad(idle, {optionId: 'summons-1'});
bad({...idle, to_bp: false}, {optionId: 'to_bp'});
bad(idle, {type: R.SELECT_IDLECMD, action: 0, index: 0});
bad(idle, {optionId: 'summons-0', optionIds: ['activates-0']});
bad(idle, {optionId: 'summons-0', cancel: true});
bad(idle, {optionIds: ['summons-0', 'summons-0']});
eq(normalizePrompt(idle, {...context, viewer: 1}), null);
assertions++; assert.doesNotThrow(() => JSON.stringify(prompt(idle)));
eq(isPromptMessage(idle), true); eq(isPromptMessage({type: M.NEW_TURN}), false);
assertions++; assert.throws(() => prompt({type: -400, player: 0}), error => error.code === 'AUTO_UNSUPPORTED_PROMPT');

const battle = {type: M.SELECT_BATTLECMD, player: 1, chains: [card()], attacks: [card(102, {can_direct: true})], to_m2: true, to_ep: true};
for (const [index, id] of ['chains-0', 'attacks-0', 'to_m2', 'to_ep'].entries()) eq(pick(battle, id), {type: R.SELECT_BATTLECMD, action: index, index: index < 2 ? 0 : null});
bad({...battle, to_m2: false}, {optionId: 'to_m2'});

for (const [type, response] of [[M.SELECT_EFFECTYN, R.SELECT_EFFECTYN], [M.SELECT_YESNO, R.SELECT_YESNO]]) {
  const message = {...card(), type, player: 0, description: 999n};
  eq(pick(message, 'yes'), {type: response, yes: true});
  eq(pick(message, 'no'), {type: response, yes: false});
  bad(message, {optionId: 'true'});
}
const option = {type: M.SELECT_OPTION, player: 0, options: [999n, 1000n]};
eq(pick(option, 'option-1'), {type: R.SELECT_OPTION, index: 1});
bad(option, {optionId: 'option--1'});

const selection = {type: M.SELECT_CARD, player: 0, can_cancel: false, min: 1, max: 2, selects: [card(), card(102)]};
eq(multi(selection, ['card-1', 'card-0']), {type: R.SELECT_CARD, indicies: [1, 0]});
bad(selection, {optionIds: []}); bad(selection, {optionIds: ['card-0', 'card-0']}); bad(selection, {optionId: 'cancel'});
eq(pick({...selection, can_cancel: true}, 'cancel'), {type: R.SELECT_CARD, indicies: null});

const toggle = {type: M.SELECT_UNSELECT_CARD, player: 0, can_finish: true, can_cancel: false, min: 1, max: 2, select_cards: [card()], unselect_cards: [card(102)]};
eq(prompt(toggle).kind, 'toggle'); eq(prompt(toggle).options[1].selected, true);
eq(pick(toggle, 'select-0'), {type: R.SELECT_UNSELECT_CARD, index: 0});
eq(pick(toggle, 'unselect-0'), {type: R.SELECT_UNSELECT_CARD, index: 1});
eq(pick(toggle, 'finish'), {type: R.SELECT_UNSELECT_CARD, index: null});
bad({...toggle, can_finish: false}, {optionId: 'finish'});

const chain = {type: M.SELECT_CHAIN, player: 0, forced: false, selects: [card(101, {description: 999n})]};
eq(pick(chain, 'chain-0'), {type: R.SELECT_CHAIN, index: 0});
eq(pick(chain, 'pass'), {type: R.SELECT_CHAIN, index: null});
bad({...chain, forced: true}, {optionId: 'pass'});
bad({...chain, forced: true}, {optionId: 'cancel'});

// Mask bits are relative to actor, and unsigned bit31 remains usable. Bit7 of
// MZONE is reserved; SZONE bit7 is an actual legacy Pendulum zone.
for (const type of [M.SELECT_PLACE, M.SELECT_DISFIELD]) {
  const message = {type, player: 1, count: 2, field_mask: (0xffffffff ^ 1 ^ 0x80000000) >>> 0};
  eq(prompt(message).options.map(item => item.id), ['place-1-4-0', 'place-0-8-7']);
  eq(multi(message, ['place-1-4-0', 'place-0-8-7']), {type: type === M.SELECT_PLACE ? R.SELECT_PLACE : R.SELECT_DISFIELD, places: [{player: 1, location: 4, sequence: 0}, {player: 0, location: 8, sequence: 7}]});
  bad(message, {optionIds: ['place-1-4-0']});
  bad(message, {optionIds: ['place-1-4-0', 'place-1-4-0']});
  bad(message, {optionIds: ['place-1-4-0', 'place-1-4-7']});
}
const position = {type: M.SELECT_POSITION, player: 0, code: 101, positions: 5};
eq(pick(position, 'position-4'), {type: R.SELECT_POSITION, position: 4});
bad(position, {optionId: 'position-8'}); bad(position, {optionId: 'position-5'});

const tribute = {type: M.SELECT_TRIBUTE, player: 0, min: 2, max: 2, can_cancel: false, selects: [card(101, {release_param: 2}), card(102, {release_param: 1})]};
eq(multi(tribute, ['card-0']), {type: R.SELECT_TRIBUTE, indicies: [0]});
bad(tribute, {optionIds: ['card-1']});

const sum = {type: M.SELECT_SUM, player: 0, select_max: 0, amount: 8, min: 1, max: 2, selects_must: [card(101, {amount: 2})], selects: [card(102, {amount: 4 | (6 << 16)}), card(101, {amount: 2}), card(102, {amount: 3})]};
eq(multi(sum, ['card-0']), {type: R.SELECT_SUM, indicies: [0]});
eq(multi(sum, ['card-0', 'card-1']), {type: R.SELECT_SUM, indicies: [0, 1]});
bad(sum, {optionIds: ['mandatory-0', 'card-0']});
bad(sum, {optionIds: ['card-2']});
bad(sum, {optionIds: ['card-0', 'card-0']});
const minimumSum = {...sum, select_max: 1, amount: 5, min: 0, max: 0, selects_must: [], selects: [card(101, {amount: 4}), card(102, {amount: 3}), card(102, {amount: 1})]};
eq(multi(minimumSum, ['card-0', 'card-1']), {type: R.SELECT_SUM, indicies: [0, 1]});
bad(minimumSum, {optionIds: ['card-0']});
bad(minimumSum, {optionIds: ['card-0', 'card-1', 'card-2']});

const counter = {type: M.SELECT_COUNTER, player: 0, count: 3, cards: [card(101, {count: 2}), card(102, {count: 5})]};
eq(resolveChoice(counter, {counts: {'counter-0': 1, 'counter-1': 2}}, context), {type: R.SELECT_COUNTER, counters: [1, 2]});
for (const counts of [{'counter-0': -1, 'counter-1': 4}, {'counter-0': 3}, {'counter-1': 2}, {'counter-1': 2.5}, {'counter-9': 3}]) bad(counter, {counts});

for (const type of [M.SORT_CARD, M.SORT_CHAIN]) {
  const sort = {type, player: 0, cards: [card(), card(102), card(103)]};
  eq(multi(sort, ['sort-2', 'sort-0', 'sort-1']), {type: R.SORT_CARD, order: [1, 2, 0]});
  bad(sort, {optionIds: ['sort-0', 'sort-2']});
  bad(sort, {optionIds: ['sort-0', 'sort-0', 'sort-2']});
  eq(pick(sort, 'cancel'), {type: R.SORT_CARD, order: null});
}
const race = {type: M.ANNOUNCE_RACE, player: 0, count: 2, available: 3n | (1n << 31n)};
eq(multi(race, ['race-1', 'race-2147483648']), {type: R.ANNOUNCE_RACE, races: [1n, 2147483648n]});
eq(resolveChoice(race, {value: '0x80000001'}, context), {type: R.ANNOUNCE_RACE, races: [1n, 2147483648n]});
bad(race, {value: '0x80000004'}); bad(race, {value: '3.5'}); bad(race, {optionIds: ['race-1', 'race-1']});
const attribute = {type: M.ANNOUNCE_ATTRIB, player: 0, count: 1, available: 2 | 4};
eq(pick(attribute, 'attribute-2'), {type: R.ANNOUNCE_ATTRIB, attributes: [2]});
bad(attribute, {value: 6}); bad(attribute, {optionId: 'attribute-16'});

const announce = {type: M.ANNOUNCE_CARD, player: 0, opcodes: [2n, OP.ISATTRIBUTE]};
eq(prompt(announce).options, []);
eq(searchPromptCards(announce, 'test', context), [{code: 101, name: 'Test WATER'}]);
eq(resolveChoice(announce, {value: 101}, context), {type: R.ANNOUNCE_CARD, card: 101});
eq(pick(announce, 'card-101'), {type: R.ANNOUNCE_CARD, card: 101});
bad(announce, {value: 102}); bad(announce, {value: 103}); bad(announce, {value: 104}); bad(announce, {value: 999999});
eq(searchPromptCards({...announce, opcodes: [1n, OP.ALLOW_ALIASES, OP.ALLOW_TOKENS]}, 'test', context).length, 4);
eq(searchPromptCards(announce, '', context), []);
const prerelease = new Map(cards).set(101, {...cards.get(101), ot: 258});
assertions++; assert.throws(() => resolveChoice(announce, {value: 101}, {cards: prerelease}), error => error.code === 'AUTO_INVALID_CHOICE');
eq(searchPromptCards(announce, 'test', {cards: prerelease}), []);
const manyCards = new Map(Array.from({length: 50}, (_, i) => [i + 1000, {...cards.get(101), code: i + 1000}]));
eq(searchPromptCards(announce, 'test', {cards: manyCards, limit: 1000}).length, 30);

const number = {type: M.ANNOUNCE_NUMBER, player: 0, options: [10n, 30n, 18446744073709551615n]};
eq(pick(number, 'number-1'), {type: R.ANNOUNCE_NUMBER, value: 1});
eq(resolveChoice(number, {value: '18446744073709551615'}, context), {type: R.ANNOUNCE_NUMBER, value: 2});
bad(number, {value: 1}); bad(number, {value: Infinity});
eq(pick({type: M.ROCK_PAPER_SCISSORS, player: 1}, 'rps-3'), {type: R.ROCK_PAPER_SCISSORS, value: 3});
bad({type: M.ROCK_PAPER_SCISSORS, player: 1}, {optionId: 'rps-4'});

// Raw script/database/private properties cannot be forwarded by object spread.
const privatePrompt = prompt({...selection, privateSeed: 'secret', cards: 'private', selects: [{...card(), secret: 'hidden', description: 999n}]});
const json = JSON.stringify(privatePrompt);
eq(json.includes('secret'), false); eq(json.includes('hidden'), false); eq(json.includes('privateSeed'), false);
const coveredTarget = {...selection, selects: [card(101, {controller: 1, position: 8})]};
eq(prompt(coveredTarget).options[0].card.code, 0);
eq(prompt(coveredTarget).options[0].card.hidden, true);
eq(prompt(coveredTarget).options[0].label.includes('WATER'), false);
eq(prompt(coveredTarget).options[0].card.sequence, 0);
eq(normalizePrompt(coveredTarget, {...context, isCardVisible: () => true}).options[0].card.code, 101);
eq(pick(coveredTarget, 'card-0'), {type: R.SELECT_CARD, indicies: [0]});
console.log(`Yu-Gi-Oh automatic prompt smoke: ${assertions} assertions passed.`);
