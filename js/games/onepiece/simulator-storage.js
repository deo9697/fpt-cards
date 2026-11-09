// Duel data never enters app state, RPCs, Realtime or shared collections.
export const simulatorScope = context => JSON.stringify([context?.team, context?.member]);
const prefix = context => `fpt-op-simulator-v1:${encodeURIComponent(simulatorScope(context))}`;
const string = (value, maximum) => typeof value === 'string' && value.length <= maximum;
const side = player => player && typeof player === 'object' && !Array.isArray(player)
  && string(player.name, 80) && string(player.deckId, 100) && string(player.deckName, 200)
  && Array.isArray(player.cards) && player.cards.length === 51
  && player.cards.every(card => card && string(card.catalogCardId, 100) && card.catalogCardId.trim()
    && (card.printingId === null || string(card.printingId, 100)));
function resultSnapshot(row) {
  if (!row || typeof row !== 'object' || !string(row.id, 100) || !row.id
    || !string(row.endedAt, 40) || !Number.isFinite(Date.parse(row.endedAt))
    || ![0, 1].includes(row.firstPlayer) || !Number.isInteger(row.turns) || row.turns < 1 || row.turns > 100000
    || ![0, 1, 'draw'].includes(row.winner) || !string(row.notes, 4000)
    || !Array.isArray(row.players) || row.players.length !== 2 || !row.players.every(side)) return null;
  // Keep only result data and deck identities, never a hand, Life order or log.
  return {
    id: row.id, endedAt: row.endedAt, firstPlayer: row.firstPlayer, turns: row.turns, winner: row.winner, notes: row.notes,
    players: row.players.map(player => ({ name: player.name, deckId: player.deckId, deckName: player.deckName,
      cards: player.cards.map(card => ({ catalogCardId: card.catalogCardId, printingId: card.printingId }))
        .sort((a, b) => a.catalogCardId.localeCompare(b.catalogCardId) || String(a.printingId || '').localeCompare(String(b.printingId || ''))) }))
  };
}
function browserStorage(name) {
  try { return globalThis[name]; } catch { return null; }
}
export class SimulatorStorage {
  constructor(context, options = {}) {
    this.key = prefix(context);
    // Access to the global Storage getters can itself throw in privacy modes.
    // Reads then fall back safely; writes still throw so the UI can warn users.
    this.session = options.session === undefined ? browserStorage('sessionStorage') : options.session;
    this.history = options.history === undefined ? browserStorage('localStorage') : options.history;
  }
  readSession() { return this.read(this.session, `${this.key}:table`, null); }
  writeSession(value) { this.session.setItem(`${this.key}:table`, JSON.stringify(value)); }
  clearSession() { this.session.removeItem(`${this.key}:table`); }
  readHistory() {
    const rows = this.read(this.history, `${this.key}:results`, []);
    if (!Array.isArray(rows)) return [];
    const seen = new Set(), valid = [];
    for (const row of rows) {
      const snapshot = resultSnapshot(row);
      if (!snapshot || seen.has(snapshot.id)) continue;
      seen.add(snapshot.id); valid.push(snapshot);
      if (valid.length === 100) break;
    }
    return valid;
  }
  saveResult(row) {
    const snapshot = resultSnapshot(row);
    if (!snapshot) throw new Error('Risultato del test non valido.');
    const rows = [snapshot, ...this.readHistory().filter(item => item.id !== snapshot.id)].slice(0, 100);
    this.history.setItem(`${this.key}:results`, JSON.stringify(rows));
    return rows;
  }
  clearHistory() { this.history.removeItem(`${this.key}:results`); }
  read(storage, key, fallback) {
    try { return JSON.parse(storage.getItem(key) || 'null') ?? fallback; } catch { return fallback; }
  }
}
