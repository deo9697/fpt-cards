// SPDX-License-Identifier: AGPL-3.0-or-later
import { parentPort } from 'node:worker_threads';
import { createAutoState, applyAutoInput, searchAutoCards } from './_yugioh-auto-core.js';
import { loadAutoResources } from './_yugioh-auto-resources.js';
import { validateAutoDeck } from './_yugioh-auto-deck-rules.js';

// Serialized jobs share only checked immutable card/script resources. The core
// creates/destroys a fresh native duel for each persisted replay, so no user
// game or failed move can contaminate another job on a warm instance.
// Carica carte e script appena il worker nasce (anche se avviato da prewarm):
// il primo lavoro trova il catalogo già pronto o in arrivo.
void loadAutoResources().catch(()=>{});
parentPort.on('message',async ({id,operation,payload})=>{
try {
  let value;
  if (operation === 'validate') { const deck = validateAutoDeck(payload.deck, await loadAutoResources()); value = {valid:true,deckName:deck.name}; }
  else if (operation === 'create') value = await createAutoState(payload);
  else if (operation === 'createPractice') value = await createAutoState({...payload,firstPlayer:0,passivePlayer:1});
  else if (operation === 'apply') { const { state, ...input } = payload; value = await applyAutoInput(state, input); }
  else if (operation === 'search') { const { state, ...input } = payload; value = await searchAutoCards(state, input); }
  else throw new Error('Operazione non valida.');
  parentPort.postMessage({ id, ok: true, value });
} catch (error) {
  parentPort.postMessage({ id, ok: false, message: error.message, code: error.code, status: error.status });
}
});
