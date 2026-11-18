// Dallo stato del duello PRIMA e DOPO un aggiornamento ricava gli effetti da
// mostrare (simulator-fx.js): cambio di turno, cambio di fase, mostri appena
// arrivati in campo. Solo lettura: non decide nulla, guarda cosa il motore ha
// già fatto. Funzione pura (testabile senza DOM).
const BOARD_MONSTERS = ['monsters', 'extraMonsters'];
const PHASES = new Set(['draw', 'standby', 'main1', 'battle', 'main2', 'end']);
const MAX_SUMMONS = 2; // più evocazioni nello stesso aggiornamento: solo le ultime due

function boardCards(player) {
  return BOARD_MONSTERS.flatMap(zone => (Array.isArray(player?.[zone]) ? player[zone] : []).filter(Boolean));
}
function idsIn(player, zones) {
  return new Set(zones.flatMap(zone => (Array.isArray(player?.[zone]) ? player[zone] : []).filter(Boolean).map(card => String(card.id))));
}
export function summonTypeOf(card, cameFromHand) {
  const type = String(card?.type || '').toLowerCase();
  if (card?.faceUp === false) return 'set';
  if (/synchro/.test(type)) return 'synchro';
  if (/xyz/.test(type)) return 'xyz';
  if (/\blink\b/.test(type)) return 'link';
  if (/fusion/.test(type)) return 'fusion';
  if (/ritual/.test(type)) return 'ritual';
  return cameFromHand ? 'normal' : 'special';
}

export function duelFxEvents(previous, next, viewer) {
  if (!previous || !next || !Array.isArray(next.players) || !Array.isArray(previous.players)) return [];
  const events = [];
  const playerName = index => next.players[index]?.name || '';
  if (next.turn !== previous.turn && Number.isFinite(Number(next.turn))) {
    events.push({ kind: 'phase', name: next.activePlayer === viewer ? 'your-turn' : 'opponent-turn', turn: next.turn, player: playerName(next.activePlayer) });
  }
  if (next.phase !== previous.phase && PHASES.has(next.phase)) {
    events.push({ kind: 'phase', name: next.phase, turn: next.turn, player: playerName(next.activePlayer) });
  }
  const summons = [];
  next.players.forEach((player, index) => {
    const before = previous.players[index];
    const wasOnBoard = idsIn(before, BOARD_MONSTERS), wasInHand = idsIn(before, ['hand']);
    for (const card of boardCards(player)) {
      const id = String(card.id);
      if (wasOnBoard.has(id)) continue;
      // Tavolo automatico: gli id dipendono dalla posizione, quindi «dalla mano»
      // si riconosce anche dal codice uscito dalla mano (o da una mano coperta che cala).
      const code = card.code ?? card.catalogCardId, beforeHand = before?.hand || [], afterHand = player.hand || [];
      const leftHand = code != null && beforeHand.filter(item => !item.hidden && (item.code ?? item.catalogCardId) === code).length > afterHand.filter(item => !item.hidden && (item.code ?? item.catalogCardId) === code).length;
      const hiddenHandShrank = beforeHand.filter(item => item.hidden).length > afterHand.filter(item => item.hidden).length;
      const type = summonTypeOf(card, wasInHand.has(id) || leftHand || (card.hidden !== true && hiddenHandShrank && !wasInHand.size));
      const hidden = type === 'set' || card.hidden === true;
      summons.push({
        kind: 'summon', type, player: index,
        image: hidden ? '' : String(card.imageUrl || ''), name: hidden ? 'Carta coperta' : String(card.name || card.cardName || ''),
        level: Number(card.level) || undefined, rank: Number(card.rank) || undefined,
        link: Number(card.linkRating ?? card.linkval ?? card.link) || undefined,
        materials: Array.isArray(card.materials) ? card.materials.length || undefined : undefined,
      });
    }
  });
  return events.concat(summons.slice(-MAX_SUMMONS));
}
