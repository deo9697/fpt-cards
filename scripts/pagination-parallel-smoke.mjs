// Paginazione in parallelo a totale noto (2026-10-24): la Raccolta del team
// (3.600+ righe) erano 8 richieste in fila. Con il count di PostgREST sulla
// prima pagina, le altre partono insieme (max 3), mai oltre l'ultima pagina.
import assert from 'node:assert/strict';
import { collectPages, pagedRpc } from '../js/pagination.js';

const makeRows = n => Array.from({ length: n }, (_, i) => ({ id: `r${i}` }));
async function run(total, { withTotal = true, delay = 30 } = {}) {
  const all = makeRows(total), ranges = [];
  let inFlight = 0, maxInFlight = 0;
  const started = Date.now();
  const rows = await collectPages(async (from, to, index) => {
    ranges.push([from, to]); inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise(resolve => setTimeout(resolve, delay));
    inFlight--;
    const page = all.slice(from, to + 1);
    if (index === 0 && withTotal) page.total = total;
    return page;
  }, { resource: 'test', pageSize: 500 });
  return { rows, ranges: ranges.sort((a, b) => a[0] - b[0]), maxInFlight, elapsed: Date.now() - started };
}

// 3.661 righe come la Raccolta del team: 8 pagine, nessuna in più, ordine intatto.
const team = await run(3661);
assert.equal(team.rows.length, 3661);
assert.deepEqual(team.rows.map(row => row.id), makeRows(3661).map(row => row.id), 'righe nell\'ordine giusto');
assert.deepEqual(team.ranges, Array.from({ length: 8 }, (_, i) => [i * 500, i * 500 + 499]), 'esattamente le 8 pagine necessarie');
assert.ok(team.maxInFlight > 1 && team.maxInFlight <= 3, `in parallelo, al massimo 3 (viste ${team.maxInFlight})`);
const sequential = await run(3661, { withTotal: false });
assert.equal(sequential.maxInFlight, 1, 'senza totale: una pagina alla volta come prima');
assert.ok(team.elapsed < sequential.elapsed * 0.75, `più veloce (${team.elapsed} ms contro ${sequential.elapsed} ms)`);

// Casi limite: meno di una pagina, multiplo esatto, totale vuoto.
assert.deepEqual((await run(120)).ranges, [[0, 499]]);
const exact = await run(1000);
assert.equal(exact.rows.length, 1000);
assert.deepEqual(exact.ranges, [[0, 499], [500, 999], [1000, 1499]], 'multiplo esatto: la pagina vuota finale come prima');
assert.equal((await run(0)).rows.length, 0);

// Righe aggiunte tra la prima pagina e le altre: si continua finché c'è una pagina corta.
let grown = makeRows(1200);
const growing = await collectPages(async (from, to, index) => { if (index === 1) grown = makeRows(1700); const page = grown.slice(from, to + 1); if (index === 0) page.total = 1200; return page; }, { resource: 'test', pageSize: 500 });
assert.equal(growing.length, 1700, 'nessuna riga persa se il totale cresce nel frattempo');

// Un errore su una pagina necessaria si propaga come prima.
await assert.rejects(collectPages(async (from, to, index) => { if (index === 2) throw new Error('rete'); const page = makeRows(3000).slice(from, to + 1); if (index === 0) page.total = 3000; return page; }, { resource: 'test', pageSize: 500 }), /rete/);

// pagedRpc chiede il count sulla prima pagina e lo passa a collectPages.
const calls = [];
const builder = (opts, rangeLog) => ({ order() { return this; }, range(from, to) { rangeLog.push([from, to]); this.from = from; this.to = to; return this; }, abortSignal() { return this; }, then(resolve) { const data = makeRows(1300).slice(this.from, this.to + 1); resolve({ data, count: opts?.count === 'exact' ? 1300 : null, error: null }); } });
const rangeLog = [];
const fakeClient = { rpc(name, args, opts) { calls.push(opts || null); return builder(opts, rangeLog); } };
const viaRpc = await pagedRpc(fakeClient, 'list_team_collection', { p_token: 't' }, { orders: [{ column: 'id' }] });
assert.equal(viaRpc.length, 1300);
assert.equal(calls[0]?.count, 'exact', 'prima pagina con count esatto');
assert.equal(rangeLog.length, 3, 'tre pagine per 1.300 righe, nessuna in più');
console.log(`PASS paginazione: pagine in parallelo a totale noto (${team.elapsed} ms invece di ${sequential.elapsed} ms per 3.661 righe), nessuna richiesta oltre l'ultima pagina, ordine e controlli invariati`);
