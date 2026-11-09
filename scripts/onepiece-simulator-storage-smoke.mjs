import assert from 'node:assert/strict';
import { SimulatorStorage, simulatorScope } from '../js/games/onepiece/simulator-storage.js';

class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}
const memory = () => ({ session: new MemoryStorage(), history: new MemoryStorage() });
const context = { team: 'team-onepiece', member: 'alice' };
const result = (id = 'session-1') => ({
  id,
  endedAt: '2026-11-09T12:00:00.000Z',
  firstPlayer: 0,
  turns: 10,
  winner: 0,
  notes: 'Test privato',
  players: [0, 1].map(player => ({
    name: `Lato ${player}`, deckId: `deck-${player}`, deckName: `Deck ${player}`,
    cards: Array.from({ length: 51 }, (_, index) => ({ catalogCardId: `OP01-${String(index + 1).padStart(3, '0')}`, printingId: null }))
  }))
});

const backing = memory();
const alice = new SimulatorStorage(context, backing);
const bob = new SimulatorStorage({ ...context, member: 'bob' }, backing);
const otherTeam = new SimulatorStorage({ ...context, team: 'team-other' }, backing);
assert.notEqual(simulatorScope(context), simulatorScope({ ...context, team: 'team-other' }));
assert.notEqual(simulatorScope(context), simulatorScope({ ...context, member: 'bob' }));
assert.notEqual(simulatorScope({ team: 'a:b', member: 'c' }), simulatorScope({ team: 'a', member: 'b:c' }), 'scope separators cannot collide');
assert.equal(alice.readSession(), null);
assert.deepEqual(alice.readHistory(), []);
alice.writeSession({ version: 1, id: 'alice-table' });
assert.deepEqual(alice.readSession(), { version: 1, id: 'alice-table' });
assert.equal(bob.readSession(), null);
assert.equal(otherTeam.readSession(), null);
const tableKey = [...backing.session.values.keys()][0];
assert.equal(backing.history.values.size, 0, 'table never enters persistent local history');
alice.saveResult(result());
assert.equal(alice.readHistory().length, 1);
assert.deepEqual(bob.readHistory(), []);
assert.deepEqual(otherTeam.readHistory(), []);
const resultsKey = [...backing.history.values.keys()][0];
assert.ok(!backing.session.values.has(resultsKey), 'results and table use separate storage areas');

// Re-saving a finished table replaces that result instead of counting it twice.
alice.saveResult({ ...result(), notes: 'Risultato ritentato' });
assert.equal(alice.readHistory().length, 1);
assert.equal(alice.readHistory()[0].notes, 'Risultato ritentato');
for (let index = 0; index < 105; index++) alice.saveResult(result(`session-${index}`));
assert.equal(alice.readHistory().length, 100);
assert.equal(alice.readHistory()[0].id, 'session-104');
assert.equal(alice.readHistory().at(-1).id, 'session-5');
assert.equal(new Set(alice.readHistory().map(row => row.id)).size, 100);
alice.clearSession();
assert.equal(alice.readSession(), null);
assert.equal(alice.readHistory().length, 100, 'closing table preserves finished private tests');
bob.writeSession({ id: 'bob-table' });
bob.saveResult(result('bob-result'));
alice.clearHistory();
assert.deepEqual(alice.readHistory(), []);
assert.equal(bob.readHistory().length, 1);
assert.deepEqual(bob.readSession(), { id: 'bob-table' });

for (const raw of ['{broken', '', 'null', '42', '{}', '"history"']) {
  backing.history.setItem(resultsKey, raw);
  assert.deepEqual(alice.readHistory(), [], `malformed history ${raw} is ignored`);
}
backing.session.setItem(tableKey, '{broken');
assert.equal(alice.readSession(), null, 'corrupt JSON table fails closed');

// A valid-looking wrapper with malformed nested players used to crash historyView.
const malformed = [
  null,
  {},
  { ...result('bad-players-null'), players: [null, null] },
  { ...result('bad-player-string'), players: ['A', 'B'] },
  { ...result('bad-players-empty'), players: [{}, {}] },
  { ...result('bad-first'), firstPlayer: 99 },
  { ...result('bad-first-string'), firstPlayer: '0' },
  { ...result('bad-winner'), winner: 2 },
  { ...result('bad-date'), endedAt: 'invalid' },
  { ...result('bad-turns'), turns: -1 },
  { ...result('bad-turns-string'), turns: '10' },
  { ...result('bad-notes'), notes: { private: 'object' } }
];
backing.history.setItem(resultsKey, JSON.stringify([result('good-before'), ...malformed, result('good-after')]));
assert.deepEqual(alice.readHistory().map(row => row.id), ['good-before', 'good-after'], 'invalid nested history rows are skipped without losing valid results');
backing.history.setItem(resultsKey, JSON.stringify([result('duplicate'), result('duplicate')]));
assert.equal(alice.readHistory().length, 1, 'malformed duplicate history entries cannot double-count tests');
assert.throws(() => alice.saveResult({ ...result(), players: [null, null] }), /non valido/);
const withSecrets = result('sanitized');
withSecrets.hand = ['private'];
withSecrets.log = [{ text: 'private' }];
withSecrets.players[0].hand = ['private'];
withSecrets.players[0].cards.reverse();
alice.saveResult(withSecrets);
const sanitized = alice.readHistory()[0];
assert.equal(Object.hasOwn(sanitized, 'hand'), false);
assert.equal(Object.hasOwn(sanitized, 'log'), false);
assert.equal(Object.hasOwn(sanitized.players[0], 'hand'), false);
assert.equal(sanitized.players[0].cards[0].catalogCardId, 'OP01-001', 'deck snapshot order never encodes hidden-zone order');

// Availability failures are safe on reads and visible to write callers.
const unavailable = {
  getItem() { throw new Error('Storage unavailable'); },
  setItem() { throw new Error('Quota exceeded'); },
  removeItem() { throw new Error('Storage unavailable'); }
};
const blocked = new SimulatorStorage(context, { session: unavailable, history: unavailable });
assert.equal(blocked.readSession(), null);
assert.deepEqual(blocked.readHistory(), []);
assert.throws(() => blocked.writeSession({ id: 'table' }), /Quota exceeded/);
assert.throws(() => blocked.saveResult(result()), /Quota exceeded/);
assert.throws(() => blocked.clearSession(), /Storage unavailable/);
assert.throws(() => blocked.clearHistory(), /Storage unavailable/);

// The browser can throw even while obtaining the Storage object (privacy mode).
const globals = ['sessionStorage', 'localStorage'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
try {
  for (const [name] of globals) Object.defineProperty(globalThis, name, { configurable: true, get() { throw new Error('Storage access denied'); } });
  const noBrowserStorage = new SimulatorStorage(context);
  assert.equal(noBrowserStorage.readSession(), null);
  assert.deepEqual(noBrowserStorage.readHistory(), []);
  assert.throws(() => noBrowserStorage.writeSession({ id: 'table' }));
  assert.throws(() => noBrowserStorage.saveResult(result()));
} finally {
  for (const [name, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
}
console.log('One Piece simulator storage: team/member isolation, deduplication, bounded history, malformed saves and storage failures passed.');
