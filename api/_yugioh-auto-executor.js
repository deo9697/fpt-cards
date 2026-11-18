// SPDX-License-Identifier: AGPL-3.0-or-later
import { createAutoWorkerPool } from './_yugioh-auto-pool.js';

// A duel is persisted as a pinned seed + validated inputs, never as a warm
// process. Bounded reusable workers avoid reloading the immutable catalogue for
// every micro-choice; each job still gets a fresh WASM duel and a hard timeout.
const pool = createAutoWorkerPool();
const operations = new Set(['validate', 'create', 'createPractice', 'apply', 'search']);
const publicKeys = ['id', 'status', 'firstPlayer', 'startingPlayer', 'mode', 'format', 'players', 'turn', 'phase', 'activePlayer', 'chain', 'log', 'result', 'auto', 'lastBattle', 'battle'];
export function projectAutoStateSafe(state, viewer) {
  if (![0, 1].includes(viewer) || state?.mode !== 'auto' || !state.publicViews?.[viewer]) throw new Error('Stato automatico non disponibile.');
  const view = state.publicViews[viewer];
  return JSON.parse(JSON.stringify({...(state.id ? {id:state.id} : {}),...Object.fromEntries(publicKeys.filter(key => Object.hasOwn(view, key)).map(key => [key, view[key]]))}));
}

export function prewarmAutoEngine() { return pool.prewarm(); }
export async function runAutoOperation(operation, payload, { timeoutMs = 20000 } = {}) {
  if (!operations.has(operation)) throw new Error('Operazione automatica non valida.');
  if (Buffer.byteLength(JSON.stringify(payload)) > 4000000) throw Object.assign(new Error('Il duello ha raggiunto il limite di elaborazione.'), { status: 422, code: 'auto_limit' });
  return pool.run(operation,payload,{timeoutMs});
}
