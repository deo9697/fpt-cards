// /api/card-names (2026-11-21): Italian official names -> English, so the
// card search finds recent cards YGOPRODeck has no Italian name for (MAMS).
import assert from 'node:assert/strict';
import handler, { buildEntries, searchEntries, normalizeCardName } from '../api/card-names.js';

const it = { 'Angelechy Arruolato': [23308], 'Mago Nero': [4041], 'Mago Nero Toon': [6000], 'Fioritura di Cenere & Gioiosa Primavera': [12950], 'Senza inglese': [99] };
const en = { 'Angelechy Enlisted': [23308], 'Dark Magician': [4041], 'Toon Dark Magician': [6000], 'Ash Blossom & Joyous Spring': [12950] };
const entries = buildEntries(it, en);
assert.equal(entries.length, 4, 'a name with no English counterpart is dropped');
assert.deepEqual(searchEntries(entries, 'Angelechy Arruolato'), [{ name: 'Angelechy Arruolato', english: 'Angelechy Enlisted' }]);
assert.deepEqual(searchEntries(entries, 'arruolato').map(row => row.english), ['Angelechy Enlisted'], 'single word, any case');
assert.deepEqual(searchEntries(entries, 'mago nero').map(row => row.english), ['Dark Magician', 'Toon Dark Magician'], 'exact first, then prefix');
assert.deepEqual(searchEntries(entries, 'fioritura cenere').map(row => row.english), ['Ash Blossom & Joyous Spring'], 'words need not be consecutive');
assert.deepEqual(searchEntries(entries, 'ma'), [], 'under 3 characters: nothing');
assert.equal(normalizeCardName("Dell'Incubo – È"), 'dell incubo e');

const call = async query => { let status = 0, body = null; const res = { setHeader() {}, status(code) { status = code; return res; }, json(value) { body = value; return res; } }; await handler({ method: 'GET', query }, res); return { status, body }; };
assert.equal((await call({ q: 'mago', lang: 'xx' })).status, 400, 'unsupported language');
assert.deepEqual((await call({ q: 'ab', lang: 'it' })).body, { results: [] }, 'short query answers without fetching');
let res = { code: 0 }; await handler({ method: 'POST', query: {} }, { setHeader() {}, status(code) { res.code = code; return this; }, json() { return this; } });
assert.equal(res.code, 405);
console.log('PASS card-names: IT->EN index, exact/prefix ranking, scattered words, short query, language and method guards');
