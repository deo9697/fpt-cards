// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import {OcgType as T} from 'ocgcore-wasm';
import {loadAutoResources} from '../api/_yugioh-auto-resources.js';
import {AUTO_TCG_BANLIST, AUTO_TCG_LIMITS, validateAutoDeck} from '../api/_yugioh-auto-deck-rules.js';

const resources = await loadAutoResources();
const normals = [...resources.cards.values()].filter(card => card.ot === 3 && card.type === (T.MONSTER | T.NORMAL) && !card.alias && !(card.code in AUTO_TCG_LIMITS)).slice(0, 60).map(card => card.code);
const extra = [...resources.cards.values()].filter(card => card.ot === 3 && (card.type & T.MONSTER) && (card.type & (T.FUSION | T.SYNCHRO | T.XYZ | T.LINK)) && !card.alias && !(card.code in AUTO_TCG_LIMITS) && resources.scripts.has(`c${card.code}.lua`)).slice(0, 16).map(card => card.code);
const deck = (main = normals.slice(0, 40), addition = {}) => ({id: 'saved-1', name: 'Prova TCG', main, extra: [], side: [], ...addition});
let assertions = 0;
const eq = (a, b) => { assertions++; assert.deepEqual(a, b); };
const bad = (input, code, custom = resources) => { assertions++; assert.throws(() => validateAutoDeck(input, custom), error => error.code === code); };
eq(validateAutoDeck(deck(), resources), deck());
eq(validateAutoDeck(deck(normals.slice(0, 60), {extra: extra.slice(0, 15), side: normals.slice(0, 15)}), resources).main.length, 60);
bad(deck(normals.slice(0, 39)), 'invalid_deck');
bad(deck([...normals, normals[0]]), 'invalid_deck');
bad(deck(undefined, {extra}), 'invalid_deck');
bad(deck(undefined, {side: normals.slice(0, 16)}), 'invalid_deck');
bad(deck(undefined, {extra: 'invalid'}), 'invalid_deck');
bad(null, 'invalid_deck');
bad({id: 'empty', cards: []}, 'invalid_deck');
bad(deck([1234567890, ...normals.slice(1, 40)]), 'unsupported_card');
bad(deck([NaN, ...normals.slice(1, 40)]), 'invalid_card');
bad(deck(['0x123', ...normals.slice(1, 40)]), 'invalid_card');

const saved = {id: 'saved-1', name: 'Prova TCG', cards: normals.slice(0, 40).map(code => ({catalogCardId: String(code), quantity: 1, section: 'main', banlistInfo: {ban_tcg: 'Forbidden'}}))};
eq(validateAutoDeck(saved, resources), deck());
bad({...saved, cards: [{...saved.cards[0], quantity: 4}, ...saved.cards.slice(1)]}, 'invalid_deck');
bad({...saved, cards: [{...saved.cards[0], section: 'graveyard'}, ...saved.cards.slice(1)]}, 'invalid_deck');
eq(validateAutoDeck(deck([...Array(3).fill(normals[0]), ...normals.slice(1, 38)]), resources).main.length, 40);
bad(deck([...Array(4).fill(normals[0]), ...normals.slice(1, 37)]), 'invalid_deck');
bad(deck(undefined, {side: [normals[0], normals[0], normals[0]]}), 'invalid_deck');
bad(deck([extra[0], ...normals.slice(1, 40)]), 'invalid_deck');
bad(deck(undefined, {extra: [normals[0]]}), 'invalid_deck');
// Side Deck can contain both Extra and Main Deck cards.
eq(validateAutoDeck(deck(undefined, {side: [extra[0], normals[0]]}), resources).side, [extra[0], normals[0]]);

const swap = (code, overrides) => ({...resources, cards: new Map(resources.cards).set(code, {...resources.cards.get(code), ...overrides})});
const first = normals[0], second = normals[1];
const aliases = swap(second, {alias: first});
bad(deck([first, first, second, second, ...normals.slice(2, 38)]), 'invalid_deck', aliases);
const chained = {...resources, cards: new Map(resources.cards).set(second, {...resources.cards.get(second), alias: first}).set(normals[2], {...resources.cards.get(normals[2]), alias: second})};
bad(deck([first, second, normals[2], normals[2], ...normals.slice(3, 39)]), 'invalid_deck', chained);
bad(deck(), 'unsupported_card', swap(first, {alias: first}));
for (const ot of [0, 1, 4, 8, 16, 32, 64, 128, 257, 258]) bad(deck(), 'illegal_tcg_card', swap(first, {ot}));
for (const type of [T.MONSTER | T.TOKEN, T.MONSTER | T.MAXIMUM, 0x8000000, T.MONSTER | 0x10000000, 0]) bad(deck(), 'illegal_tcg_card', swap(first, {type}));

// Saved metadata cannot override the authoritative pinned list.
eq(AUTO_TCG_BANLIST.effectiveDate, '2026-10-19');
eq(AUTO_TCG_BANLIST.sourceSha256.length, 64);
eq(Object.values(AUTO_TCG_LIMITS).filter(limit => limit === 0).length, 158);
eq(AUTO_TCG_LIMITS[55144522], 0); // Pot of Greed
eq(AUTO_TCG_LIMITS[83764718], 1); // Monster Reborn
eq(AUTO_TCG_LIMITS[63166095], 2); // Sky Striker Mobilize - Engage!
bad(deck([55144522, ...normals.slice(1, 40)], {banlist: 'unlimited'}), 'forbidden_card');
bad({...saved, cards: [{catalogCardId: '55144522', section: 'main', quantity: 1, banlistInfo: {ban_tcg: 'Unlimited'}}, ...saved.cards.slice(1)]}, 'forbidden_card');
eq(validateAutoDeck(deck([83764718, ...normals.slice(1, 40)]), resources).main[0], 83764718);
bad(deck([83764718, 83764718, ...normals.slice(2, 40)]), 'limited_card');
bad(deck([83764718, ...normals.slice(1, 40)], {side: [83764718]}), 'limited_card');
bad(deck([83764718, 83764719, ...normals.slice(2, 40)]), 'limited_card');
eq(validateAutoDeck(deck([63166095, 63166095, ...normals.slice(2, 40)]), resources).main.length, 40);
bad(deck([63166095, 63166095, 63166095, ...normals.slice(3, 40)]), 'limited_card');
bad(deck([12580477, ...normals.slice(1, 40)]), 'unsupported_script', {...resources, scripts: new Map()});
eq(validateAutoDeck(deck(), {...resources, scripts: new Map()}).main.length, 40);

console.log(`Yu-Gi-Oh TCG deck legality smoke: ${assertions} assertions passed (${AUTO_TCG_BANLIST.id}).`);
