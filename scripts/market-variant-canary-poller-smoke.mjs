// pollMarketVariantCanaryRun() (js/market-variant-canary.js) è la parte
// client-side del canale canary admin-only: aspetta che una run passi da
// pending/running a succeeded/failed, con timeout. Puro, iniettabile,
// nessun bisogno di window/Supabase reali.
import assert from 'node:assert/strict';
import { pollMarketVariantCanaryRun } from '../js/market-variant-canary.js';

// 1) Già risolta al primo fetch: nessuna attesa, nessuna chiamata a sleep.
{
  let calls = 0, slept = 0;
  const run = await pollMarketVariantCanaryRun(
    async () => { calls++; return { run_id: 'r1', status: 'succeeded', result: { rows: [] } }; },
    'r1',
    { sleep: async () => { slept++; } }
  );
  assert.equal(calls, 1);
  assert.equal(slept, 0);
  assert.equal(run.status, 'succeeded');
}

// 2) pending -> running -> succeeded: continua a fare polling finché non è terminale.
{
  const statuses = ['pending', 'running', 'running', 'succeeded'];
  let index = 0, sleeps = 0;
  const run = await pollMarketVariantCanaryRun(
    async () => ({ run_id: 'r2', status: statuses[Math.min(index++, statuses.length - 1)] }),
    'r2',
    { sleep: async () => { sleeps++; } }
  );
  assert.equal(run.status, 'succeeded');
  assert.equal(index, 4, 'deve interrogare esattamente 4 volte (una per stato)');
  assert.equal(sleeps, 3, 'deve dormire tra un fetch e il successivo, non dopo l\'ultimo');
}

// 3) failed è terminale quanto succeeded: si ferma, non continua a fare polling.
{
  let calls = 0;
  const run = await pollMarketVariantCanaryRun(
    async () => { calls++; return { run_id: 'r3', status: 'failed', error_message: 'boom' }; },
    'r3',
    { sleep: async () => {} }
  );
  assert.equal(run.status, 'failed');
  assert.equal(calls, 1);
}

// 4) Timeout reale (millisecondi piccoli, non mockati): se la run resta
//    'running' per sempre, dopo il timeout ritorna l'ultimo stato noto con
//    timedOut:true invece di fare polling all'infinito.
{
  const startedAt = Date.now();
  const run = await pollMarketVariantCanaryRun(
    async () => ({ run_id: 'r4', status: 'running' }),
    'r4',
    { timeoutMs: 60, intervalMs: 20 }
  );
  const elapsed = Date.now() - startedAt;
  assert.equal(run.status, 'running');
  assert.equal(run.timedOut, true);
  assert.ok(elapsed < 2000, 'non deve girare oltre il timeout richiesto');
}

console.log('PASS market variant canary poller: risolve subito se già terminale, continua a fare polling su pending/running, si ferma su succeeded/failed, non gira all\'infinito');
