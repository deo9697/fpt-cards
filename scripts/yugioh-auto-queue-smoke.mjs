// Queued choices (2026-11-21): action + zone (+ position) in one request.
// The engine stays the only judge: a queued step is applied only when the next
// prompt is of that kind and the choice is legal, otherwise the prompt returns.
import assert from 'node:assert/strict';
import { createAutoState, applyAutoInput } from '../api/_yugioh-auto-core.js';
import { loadAutoResources } from '../api/_yugioh-auto-resources.js';
import { normalizeQueue, applyQueue, queuedChoice } from '../api/_yugioh-auto-queue.js';
import { OcgType } from 'ocgcore-wasm';

assert.deepEqual(normalizeQueue(undefined), []);
assert.equal(normalizeQueue([{ kind: 'place', zone: 'monsters', slot: 9 }]), null, 'casella fuori campo rifiutata');
assert.equal(normalizeQueue([{ kind: 'draw' }]), null, 'tipo di scelta sconosciuto rifiutato');
assert.equal(normalizeQueue(new Array(4).fill({ kind: 'position', position: 'attack' })), null, 'al massimo 3 scelte in coda');
console.log('PASS coda: forma validata (zone, caselle 0-4, posizione, massimo 3 passi)');

const resources = await loadAutoResources();
const normal = [...resources.cards.values()].filter(card => (card.ot & 2) && card.type === (OcgType.MONSTER | OcgType.NORMAL) && card.level <= 4 && card.attack > 0).slice(0, 40).map(card => card.code);
const deck = { name: 'Coda', main: normal };
const fresh = await createAutoState({ decks: [deck, deck], names: ['A', 'B'], firstPlayer: 0, lp: [8000, 8000], seed: 'ce'.repeat(32), passivePlayer: 1 });
const step = (state, prompt, choice) => applyAutoInput(state, { viewer: 0, promptId: prompt.id, choice });
const idle = fresh.publicViews[0].auto.prompt, summon = idle.options.find(option => option.id.startsWith('summons-'));
assert(summon, 'serve una Evocazione Normale disponibile');

// One request: Normal Summon + chosen zone M3.
let state = await step(fresh, idle, { optionId: summon.id });
assert.equal(state.publicViews[0].auto.prompt.kind, 'place', 'senza coda il motore chiede la zona (un giro in più)');
state = await applyQueue(state, normalizeQueue([{ kind: 'place', zone: 'monsters', slot: 2 }]), 0, step);
const monsters = state.publicViews[0].players[0].monsters;
assert.equal(monsters.length, 1); assert.equal(monsters[0].slot, 2, 'il mostro è nella casella scelta (M3)');
assert.notEqual(state.publicViews[0].auto.prompt?.kind, 'place', 'nessuna richiesta di zona rimasta');
console.log('PASS Evocazione Normale + zona in un solo giro, nella casella scelta');

// A queued zone of the wrong kind (S/T for a monster) stops: the zone prompt comes back unchanged.
let mismatch = await step(fresh, idle, { optionId: summon.id });
const prompt = mismatch.publicViews[0].auto.prompt;
assert.equal(queuedChoice(prompt, { kind: 'place', zone: 'spells', slot: 0 }, 0), null);
mismatch = await applyQueue(mismatch, normalizeQueue([{ kind: 'place', zone: 'spells', slot: 0 }]), 0, step);
assert.equal(mismatch.publicViews[0].auto.prompt.id, prompt.id, 'scelta non valida: si torna alla richiesta del motore');
assert.equal(mismatch.publicViews[0].players[0].monsters.length, 0, 'nessuna mossa inventata');
console.log('PASS zona non valida in coda: il motore richiede la zona come prima');
console.log('yugioh-auto-queue-smoke: OK');
