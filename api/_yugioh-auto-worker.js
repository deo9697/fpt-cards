// SPDX-License-Identifier: AGPL-3.0-or-later
import { parentPort, workerData } from 'node:worker_threads';
import { createAutoState, applyAutoInput, searchAutoCards } from './_yugioh-auto-core.js';
import { loadAutoResources } from './_yugioh-auto-resources.js';
import { validateAutoDeck } from './_yugioh-auto-deck-rules.js';

try {
  const { operation, payload } = workerData;
  let value;
  if (operation === 'validate') { const deck = validateAutoDeck(payload.deck, await loadAutoResources()); value = {valid:true,deckName:deck.name}; }
  else if (operation === 'create') value = await createAutoState(payload);
  else if (operation === 'createPractice') value = await createAutoState({...payload,firstPlayer:0,passivePlayer:1});
  else if (operation === 'apply') { const { state, ...input } = payload; value = await applyAutoInput(state, input); }
  else if (operation === 'search') { const { state, ...input } = payload; value = await searchAutoCards(state, input); }
  else throw new Error('Operazione non valida.');
  parentPort.postMessage({ ok: true, value });
} catch (error) {
  parentPort.postMessage({ ok: false, message: error.message, code: error.code, status: error.status });
}
