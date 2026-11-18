// SPDX-License-Identifier: AGPL-3.0-or-later
import { Worker } from 'node:worker_threads';

// A duel is persisted as a pinned seed + validated inputs, never as a warm
// process. A separate worker bounds synchronous Lua/WASM work on every request.
const operations = new Set(['validate', 'create', 'createPractice', 'apply', 'search']);
const publicKeys = ['id', 'status', 'firstPlayer', 'startingPlayer', 'mode', 'format', 'players', 'turn', 'phase', 'activePlayer', 'chain', 'log', 'result', 'auto', 'lastBattle', 'battle'];
export function projectAutoStateSafe(state, viewer) {
  if (![0, 1].includes(viewer) || state?.mode !== 'auto' || !state.publicViews?.[viewer]) throw new Error('Stato automatico non disponibile.');
  const view = state.publicViews[viewer];
  return JSON.parse(JSON.stringify({...(state.id ? {id:state.id} : {}),...Object.fromEntries(publicKeys.filter(key => Object.hasOwn(view, key)).map(key => [key, view[key]]))}));
}

export async function runAutoOperation(operation, payload, { timeoutMs = 20000 } = {}) {
  if (!operations.has(operation)) throw new Error('Operazione automatica non valida.');
  if (Buffer.byteLength(JSON.stringify(payload)) > 4000000) throw Object.assign(new Error('Il duello ha raggiunto il limite di elaborazione.'), { status: 422, code: 'auto_limit' });
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./_yugioh-auto-worker.js', import.meta.url), {
      workerData: { operation, payload }, resourceLimits: { maxOldGenerationSizeMb: 512 },
    });
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); void worker.terminate();
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => finish(Object.assign(new Error('Il motore non ha risposto in tempo. La mossa non è stata salvata; puoi riprovare.'), { status: 503, code: 'auto_timeout' })), timeoutMs);
    worker.once('message', message => message.ok ? finish(null, message.value) : finish(Object.assign(new Error(message.message || 'La scelta non è valida.'), { status: message.status || 400, code: message.code || 'auto_input' })));
    worker.once('error', () => finish(Object.assign(new Error('Motore del duello non disponibile. La partita è conservata.'), { status: 503, code: 'auto_worker' })));
    worker.once('exit', () => { if (!settled) finish(Object.assign(new Error('Elaborazione del duello interrotta. La mossa non è stata salvata.'), { status: 503, code: 'auto_worker' })); });
  });
}
