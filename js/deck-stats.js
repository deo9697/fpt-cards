// Statistiche della mano iniziale (2026-11-09): ogni carta del Main ha un
// ruolo scelto dall'utente (starter, estensore, hand trap, brick); si
// simulano N mani mescolate davvero e, accanto, si calcola il valore esatto
// con l'ipergeometrica, così la simulazione si verifica da sola.

export const DECK_ROLES = ['starter', 'extender', 'handtrap', 'brick'];
export const ROLE_LABELS = { starter: 'Starter', extender: 'Estensore', handtrap: 'Hand trap', brick: 'Brick', '': 'Nessuno' };
export const DEFAULT_ITERATIONS = 200000;

// Hand trap note: solo un punto di partenza, l'utente può sempre cambiarle.
const HAND_TRAP_NAMES = [
  /^ash blossom/i, /^effect veiler/i, /^infinite impermanence/i, /^ghost (ogre|belle|mourner)/i, /^droll & lock bird/i,
  /^maxx "c"/i, /^mulcharmy /i, /^nibiru/i, /^psy-framegear/i, /^d\.d\. crow/i, /^skull meister/i, /^dimension shifter/i,
  /^contact "c"/i, /^artifact lancea/i, /^bystial (magnamhut|druiswurm)/i, /^retaliating "c"/i, /^ghost sister/i
];
export function guessRole(cardName = '') {
  return HAND_TRAP_NAMES.some(pattern => pattern.test(String(cardName).trim())) ? 'handtrap' : '';
}

// Le carte del Main raggruppate per id, con il ruolo salvato o indovinato.
export function deckPool(cards = [], roles = {}) {
  const byId = new Map();
  for (const card of cards) {
    if (card.section !== 'main') continue;
    const id = String(card.catalogCardId || '');
    if (!id) continue;
    const current = byId.get(id) || { id, cardName: card.cardName || '', imageUrl: card.imageUrl || '', quantity: 0 };
    current.quantity += Math.max(0, Number(card.quantity) || 0);
    byId.set(id, current);
  }
  const entries = [...byId.values()].filter(entry => entry.quantity > 0).map(entry => {
    const saved = roles[entry.id];
    return { ...entry, role: saved === undefined ? guessRole(entry.cardName) : (DECK_ROLES.includes(saved) ? saved : '') };
  });
  const counts = { starter: 0, extender: 0, handtrap: 0, brick: 0, '': 0 };
  for (const entry of entries) counts[entry.role] += entry.quantity;
  return { entries, counts, size: entries.reduce((sum, entry) => sum + entry.quantity, 0) };
}

// Generatore con seme (mulberry32): stesso seme, stessi risultati.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CODE = { starter: 1, extender: 2, handtrap: 3, brick: 4 };

export function simulateOpeningHands(pool, { handSize = 5, iterations = DEFAULT_ITERATIONS, seed = 20261109 } = {}) {
  const size = pool.size;
  const n = Math.min(handSize, size);
  const empty = { iterations: 0, handSize: n, playable: 0, brick: 0, monoHandTrap: 0, ideal: 0, twoHandTraps: 0, anyBrickCard: 0, dead: 0, avgStarters: 0 };
  if (!size || !n) return empty;
  const deck = new Uint8Array(size);
  let index = 0;
  for (const entry of pool.entries) for (let i = 0; i < entry.quantity; i++) deck[index++] = CODE[entry.role] || 0;
  const random = mulberry32(seed);
  let playable = 0, monoHandTrap = 0, ideal = 0, twoHandTraps = 0, anyBrickCard = 0, dead = 0, starterTotal = 0;
  for (let run = 0; run < iterations; run++) {
    let starters = 0, extenders = 0, handTraps = 0, bricks = 0;
    // Fisher-Yates parziale: le prime n posizioni sono una mano uniforme.
    for (let i = 0; i < n; i++) {
      const j = i + Math.floor(random() * (size - i));
      const card = deck[j]; deck[j] = deck[i]; deck[i] = card;
      if (card === 1) starters++; else if (card === 2) extenders++; else if (card === 3) handTraps++; else if (card === 4) bricks++;
    }
    starterTotal += starters;
    if (starters) { playable++; if (handTraps) ideal++; }
    else if (handTraps) monoHandTrap++;
    else if (!extenders) dead++;
    if (handTraps >= 2) twoHandTraps++;
    if (bricks) anyBrickCard++;
  }
  const share = count => count / iterations;
  return {
    iterations, handSize: n,
    playable: share(playable), brick: 1 - share(playable), monoHandTrap: share(monoHandTrap), ideal: share(ideal),
    twoHandTraps: share(twoHandTraps), anyBrickCard: share(anyBrickCard), dead: share(dead), avgStarters: starterTotal / iterations
  };
}

// Coefficiente binomiale in virgola mobile: con mazzi da 40-60 carte e mani
// da 5-6 resta esatto ben oltre la precisione mostrata.
function choose(n, k) {
  if (k < 0 || k > n || n < 0) return 0;
  k = Math.min(k, n - k);
  let result = 1;
  for (let i = 1; i <= k; i++) result = result * (n - k + i) / i;
  return result;
}

// Probabilità di NON pescare nessuna carta di un gruppo di `copies` carte.
export function chanceNone(size, copies, handSize) { return choose(size - copies, handSize) / choose(size, handSize); }
export function chanceAtLeastOne(size, copies, handSize) { return 1 - chanceNone(size, copies, handSize); }

export function exactOpeningHands(pool, { handSize = 5 } = {}) {
  const N = pool.size, n = Math.min(handSize, N), { starter: S, extender: E, handtrap: H, brick: B } = pool.counts;
  if (!N || !n) return { handSize: n, playable: 0, brick: 0, monoHandTrap: 0, ideal: 0, twoHandTraps: 0, anyBrickCard: 0, dead: 0, avgStarters: 0 };
  const total = choose(N, n);
  const p = count => choose(N - count, n) / total;
  const noStarter = p(S), noHandTrap = p(H), noStarterNoHandTrap = p(S + H), dead = p(S + H + E);
  const oneHandTrap = H * choose(N - H, n - 1) / total;
  return {
    handSize: n,
    playable: 1 - noStarter, brick: noStarter, monoHandTrap: noStarter - noStarterNoHandTrap,
    ideal: 1 - noStarter - noHandTrap + noStarterNoHandTrap, twoHandTraps: 1 - noHandTrap - oneHandTrap,
    anyBrickCard: 1 - p(B), dead, avgStarters: n * S / N
  };
}

// Ruoli salvati per mazzo sul dispositivo.
const ROLES_KEY = 'fpt-cards-deck-roles-v1';
export function readDeckRoles(deckId) {
  try { return JSON.parse(localStorage.getItem(ROLES_KEY) || '{}')[deckId] || {}; } catch { return {}; }
}
export function writeDeckRoles(deckId, roles) {
  try {
    const all = JSON.parse(localStorage.getItem(ROLES_KEY) || '{}');
    all[deckId] = roles;
    localStorage.setItem(ROLES_KEY, JSON.stringify(all));
  } catch {}
}
