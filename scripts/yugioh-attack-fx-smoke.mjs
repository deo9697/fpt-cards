// Battle FX detection (2026-11-21): attack declarations and Life Point losses.
import assert from 'node:assert/strict';
import { battleFxEvents } from '../js/games/yugioh/simulator-attack-fx.js';

const players = (a = 8000, b = 8000) => [{ lp: a }, { lp: b }];
const base = { players: players(), battle: null };
// Auto: new declaration with a target, then a direct attack.
const attacker = { controller: 0, location: 4, sequence: 2 }, target = { controller: 1, location: 4, sequence: 1 };
let events = battleFxEvents(base, { players: players(), battle: { attacker, target, stage: 'response' } }, { auto: true });
assert.deepEqual(events.attack, { auto: true, attackerPlayer: 0, attacker, target });
assert.equal(battleFxEvents({ ...base, battle: { attacker, target } }, { players: players(), battle: { attacker, target, stage: 'damage' } }, { auto: true }), null, 'same battle: no replay of the lunge');
events = battleFxEvents(base, { players: players(), battle: { attacker, target: null } }, { auto: true });
assert.equal(events.attack.target, null, 'direct attack');
// Manual: id-based declaration.
events = battleFxEvents(base, { players: players(), battle: { id: 'b1', player: 1, attackerId: 'c9', target: { zone: 'monsters', slot: 0 } } });
assert.deepEqual(events.attack, { auto: false, attackerPlayer: 1, attackerId: 'c9', target: { zone: 'monsters', slot: 0 } });
// Damage: only decreases.
events = battleFxEvents(base, { players: players(8000, 5500), battle: null });
assert.deepEqual(events, { attack: null, damage: [{ player: 1, from: 8000, to: 5500 }] });
assert.equal(battleFxEvents(base, { players: players(9000, 8000), battle: null }), null, 'LP gain is not damage');
assert.equal(battleFxEvents(null, base), null);
console.log('PASS battle FX: attack declarations (auto/manual, direct), no duplicate lunge, Life Point losses only');
