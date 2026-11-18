// Profiles one automatic-duel move as the duel grows (2026-11-18): every move
// replays the duel from seed + transcript. Read-only, no network.
import { performance } from 'node:perf_hooks';
import { createAutoState, applyAutoInput } from '../api/_yugioh-auto-core.js';
import { choosePassiveChoice } from '../api/_yugioh-auto-passive.js';
import { loadAutoResources } from '../api/_yugioh-auto-resources.js';
import { OcgType } from 'ocgcore-wasm';
const resources = await loadAutoResources();
const main = [...resources.cards.values()].filter(c => (c.ot & 2) && c.type === (OcgType.MONSTER | OcgType.NORMAL) && c.level <= 4).slice(0, 40).map(c => c.code);
const deck = { name: 'Prova', main, extra: [] };
let state = await createAutoState({ decks: [deck, deck], names: ['A', 'B'], firstPlayer: 0, lp: [8000, 8000], seed: 'cd'.repeat(32), passivePlayer: 1 });
const context = { resources, cards: resources.cards, strings: resources.strings };
const checkpoints = new Set([1, 10, 25, 50, 100, 150]);
for (let move = 1; move <= 150 && !state.result; move++) {
  const prompt = state.publicViews[0].auto.prompt;
  const choice = choosePassiveChoice({ ...state.pendingMessage, player: 1 }, context);
  const t = performance.now();
  state = await applyAutoInput(state, { viewer: 0, promptId: prompt.id, choice });
  if (checkpoints.has(move)) console.log(`mossa ${String(move).padStart(3)} · ${String(state.inputs.length).padStart(3)} input salvati · ${(performance.now() - t).toFixed(0).padStart(4)} ms · stato ${(JSON.stringify(state).length / 1024).toFixed(0)} KB`);
}
