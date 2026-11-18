// Profiles a cold automatic practice start (2026-11-18) through the same worker
// pool as the API: without prewarm, and with prewarm overlapped with ~300 ms of
// database queries (what /api/yugioh-duel now does). Read-only, no network.
import { performance } from 'node:perf_hooks';
import { createAutoWorkerPool } from '../api/_yugioh-auto-pool.js';
import { loadAutoResources } from '../api/_yugioh-auto-resources.js';
import { OcgType } from 'ocgcore-wasm';
const resources = await loadAutoResources();
const main = [...resources.cards.values()].filter(c => (c.ot & 2) && c.type === (OcgType.MONSTER | OcgType.NORMAL) && c.level <= 4).slice(0, 40).map(c => c.code);
const payload = { decks: [{ name: 'Prova', main, extra: [] }, { name: 'Prova', main, extra: [] }], names: ['A', 'Campo di prova'], firstPlayer: 0, lp: [8000, 8000] };
const db = () => new Promise(resolve => setTimeout(resolve, 300));
for (const warm of [false, true]) {
  const pool = createAutoWorkerPool();
  const t = performance.now();
  if (warm) pool.prewarm();
  await db();
  await pool.run('createPractice', payload);
  console.log((warm ? 'con prewarm' : 'senza prewarm').padEnd(16), `richiesta completa ${(performance.now() - t).toFixed(0)} ms (di cui 300 ms database simulato)`);
  pool.close();
}
process.exit(0);
