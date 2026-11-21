// SPDX-License-Identifier: AGPL-3.0-or-later
// Scelte in coda (2026-11-21). Un'azione dal campo (Evocazione, Posiziona,
// Attiva) chiedeva al giocatore 2-3 giri col server: azione → zona →
// posizione. Ora il client manda insieme all'azione le scelte successive già
// fatte sul campo; il server le applica UNA ALLA VOLTA solo se la richiesta
// successiva del motore è proprio di quel tipo e la scelta è tra quelle
// consentite. Al primo disallineamento si ferma e restituisce la richiesta al
// giocatore, come prima: il motore resta l'unico arbitro.
const MAX_STEPS = 3;
const LOCATION = { monsters: 4, extraMonsters: 4, spells: 8, field: 8 };

export function normalizeQueue(then) {
  if (then === undefined || then === null) return [];
  if (!Array.isArray(then) || then.length > MAX_STEPS) return null;
  const steps = [];
  for (const step of then) {
    if (!step || typeof step !== 'object' || Array.isArray(step)) return null;
    if (step.kind === 'place' && Object.hasOwn(LOCATION, step.zone) && Number.isInteger(step.slot) && step.slot >= 0 && step.slot <= 4) steps.push({ kind: 'place', zone: step.zone, slot: step.slot });
    else if (step.kind === 'position' && ['attack', 'defense'].includes(step.position)) steps.push({ kind: 'position', position: step.position });
    else return null;
  }
  return steps;
}

// La scelta per la richiesta attuale, se la coda la prevede; altrimenti null.
export function queuedChoice(prompt, step, viewer) {
  if (!prompt || !step || prompt.kind !== step.kind) return null;
  if (step.kind === 'place') {
    const location = LOCATION[step.zone];
    const sequence = step.zone === 'field' ? 5 : step.zone === 'extraMonsters' ? step.slot + 5 : step.slot;
    const option = (prompt.options || []).find(item => item.place?.player === viewer && item.place.location === location && item.place.sequence === sequence);
    return option && prompt.min === 1 && prompt.max === 1 ? { optionIds: [option.id] } : null;
  }
  if (step.kind === 'position') {
    const id = step.position === 'defense' ? 'position-4' : 'position-1';
    return (prompt.options || []).some(item => item.id === id) ? { optionId: id } : null;
  }
  return null;
}

// Applica le scelte in coda dopo la mossa principale. `apply(state, prompt,
// choice)` è il normale passo del motore; un errore ferma la coda senza perdere
// lo stato già valido.
export async function applyQueue(state, steps, viewer, apply) {
  let current = state;
  for (const step of steps || []) {
    if (current?.result) break;
    const prompt = current?.publicViews?.[viewer]?.auto?.prompt;
    const choice = queuedChoice(prompt, step, viewer);
    if (!choice) break;
    try { current = await apply(current, prompt, choice); } catch { break; }
  }
  return current;
}
