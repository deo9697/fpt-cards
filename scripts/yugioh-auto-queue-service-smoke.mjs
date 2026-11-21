// Queued choices through the real practice service + worker (2026-11-21):
// one request = Normal Summon + chosen zone, with a single save.
import assert from 'node:assert/strict';
import { createPracticeService } from '../api/_yugioh-practice-service.js';
import { runAutoOperation, projectAutoStateSafe } from '../api/_yugioh-auto-executor.js';
import { loadAutoResources } from '../api/_yugioh-auto-resources.js';

const id = n => `a1000000-0000-4000-8000-${String(n).padStart(12, '0')}`, team = id(1), deckId = id(10), actor = { slug: 'owner', teamId: team, name: 'Owner' };
const clone = value => value == null ? value : structuredClone(value);
let row = null, saves = 0;
const resources = await loadAutoResources();
const main = [...resources.cards.values()].filter(card => card.ot === 3 && card.type === 17 && !card.alias && card.level <= 4).slice(0, 40).map(card => card.code);
const store = { members: async () => [{ slug: 'owner', name: 'Owner' }], deck: async () => ({ id: deckId, ownerSlug: 'owner', game: 'yugioh', name: 'Deck', main }) };
const practices = { get: async () => clone(row), insert: async next => { row = clone(next); return clone(row); }, update: async (key, version, t, s, patch) => { saves++; row = { ...row, ...clone(patch) }; return clone(row); } };
const service = createPracticeService({ store, practices, autoRuntime: { project: projectAutoStateSafe, run: runAutoOperation } });
let response = await service.run(actor, { op: 'practiceStart', deckId, requestId: id(20) });
const prompt = response.duel.state.auto.prompt, summon = prompt.options.find(option => option.id.startsWith('summons-'));
assert(summon, 'Evocazione Normale disponibile');
response = await service.run(actor, { op: 'practiceAction', duelId: response.duel.id, expectedVersion: response.duel.version, requestId: id(21), action: { type: 'autoRespond', promptId: prompt.id, choice: { optionId: summon.id }, then: [{ kind: 'place', zone: 'monsters', slot: 3 }] } });
const monsters = response.duel.state.players[0].monsters;
assert.equal(saves, 1, 'un solo salvataggio');
assert.equal(monsters.length, 1, 'mostro evocato: ' + JSON.stringify(response.duel.state.auto.prompt?.kind));
assert.equal(monsters[0].slot, 3, 'nella casella scelta (M4)');
console.log('PASS servizio reale: Evocazione Normale + zona in un solo giro e un solo salvataggio');
process.exit(0);
