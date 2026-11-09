// Local, manual tabletop. Card effects, costs and victory conditions are resolved
// by the player; this module only protects the integrity of cards and DON!!.
export const PHASES = Object.freeze(['refresh', 'draw', 'don', 'main', 'end']);
export const ZONES = Object.freeze(['deck', 'hand', 'life', 'characters', 'stage', 'trash']);
const BOARD = ['leader', 'characters', 'stage'];
const ZONE_LABELS = { deck: 'mazzo', hand: 'mano', life: 'Life', characters: 'personaggi', stage: 'Stage', trash: 'trash' };
const PHASE_LABELS = { refresh: 'Refresh', draw: 'Draw', don: 'DON!!', main: 'Main', end: 'End' };
const clone = value => JSON.parse(JSON.stringify(value));
const fail = message => { throw new Error(message); };
const integer = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const text = (value, max = 300) => typeof value === 'string' && value.length <= max;
const label = value => String(value || '').trim();

export function validateSimulatorDeck(deck) {
  const errors = [];
  if (!deck || deck.game !== 'onepiece' || !Array.isArray(deck.cards)) return { valid: false, errors: ['Scegli un mazzo One Piece.'] };
  if (deck.cards.length > 61) return { valid: false, errors: ['Il mazzo contiene troppe righe.'] };
  const counts = { leader: 0, main: 0, don: 0 };
  const copies = new Map();
  for (const card of deck.cards) {
    if (!card || !Object.hasOwn(counts, card.section) || !integer(card.quantity, 1, card.section === 'don' ? 10 : 50)) {
      errors.push('Sezione o quantità di una carta non valida.');
      continue;
    }
    counts[card.section] += card.quantity;
    if (!text(card.catalogCardId, 100) || !card.catalogCardId.trim() || !text(card.cardName, 300) || !card.cardName.trim()) errors.push('Una carta non ha nome o codice catalogo.');
    if (card.section === 'main') {
      const key = label(card.catalogCardId).toUpperCase();
      copies.set(key, (copies.get(key) || 0) + card.quantity);
    }
  }
  if (counts.leader !== 1) errors.push('Serve esattamente 1 Leader.');
  if (counts.main !== 50) errors.push(`Il Main Deck deve contenere 50 carte (attuali: ${counts.main}).`);
  // DON!! are standard resources: absent catalog images never block testing.
  if (counts.don !== 0 && counts.don !== 10) errors.push('Inserisci 10 DON!! oppure lascia vuota la sezione DON!!.');
  for (const [code, quantity] of copies) if (quantity > 4) errors.push(`${code}: massimo 4 copie, comprese le diverse illustrazioni.`);
  const leader = deck.cards.find(card => card?.section === 'leader');
  const colors = Array.isArray(leader?.colors) ? leader.colors.map(color => label(color).toLowerCase()) : [];
  if (colors.length) for (const card of deck.cards.filter(card => card?.section === 'main')) {
    if (Array.isArray(card.colors) && card.colors.length && !card.colors.some(color => colors.includes(label(color).toLowerCase()))) errors.push(`${card.cardName}: colore non compatibile con il Leader.`);
  }
  return { valid: errors.length === 0, errors, counts };
}

function snapshotCard(card, id) {
  const numeric = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
  return {
    id,
    catalogCardId: label(card.catalogCardId),
    cardName: label(card.cardName),
    imageUrl: String(card.imageUrl || '').slice(0, 2000),
    printingId: String(card.printingId || '').slice(0, 100),
    colors: Array.isArray(card.colors) ? card.colors.map(color => String(color).slice(0, 30)).slice(0, 6) : [],
    type: String(card.type || card.cardType || '').slice(0, 100),
    cost: numeric(card.cost),
    power: numeric(card.power),
    text: String(card.text || card.effect || '').slice(0, 10000),
    don: 0,
    rested: false,
    powerModifier: 0,
    faceUp: false
  };
}

function randomIndex(upperExclusive) {
  // Rejection sampling avoids modulo bias and never falls back to Math.random.
  const values = new Uint32Array(1);
  const limit = 0x100000000 - (0x100000000 % upperExclusive);
  do { globalThis.crypto.getRandomValues(values); } while (values[0] >= limit);
  return values[0] % upperExclusive;
}

function shuffled(cards) {
  const result = [...cards];
  for (let index = result.length - 1; index > 0; index--) {
    const other = randomIndex(index + 1);
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

export function createSession({ decks, firstPlayer = 0, life = [5, 5], names = [] } = {}) {
  if (!Array.isArray(decks) || decks.length !== 2) fail('Scegli un mazzo per entrambi i lati.');
  if (!integer(firstPlayer, 0, 1)) fail('Giocatore iniziale non valido.');
  if (!Array.isArray(life) || life.length !== 2 || life.some(count => !integer(count, 1, 10))) fail('Le Life iniziali devono essere comprese tra 1 e 10.');
  for (const deck of decks) {
    const validation = validateSimulatorDeck(deck);
    if (!validation.valid) fail(validation.errors.join(' '));
  }
  const at = new Date().toISOString();
  const session = {
    version: 1,
    id: globalThis.crypto.randomUUID(),
    createdAt: at,
    updatedAt: at,
    firstPlayer,
    activePlayer: firstPlayer,
    turn: 1,
    phase: 'setup',
    players: decks.map((deck, player) => {
      let index = 0;
      const cards = shuffled(deck.cards.filter(card => card.section === 'main').flatMap(card => Array.from({ length: card.quantity }, () => snapshotCard(card, `p${player}-main-${index++}`))));
      const hand = cards.splice(0, 5);
      return {
        name: label(names[player] || `Lato ${player === 0 ? 'A' : 'B'}`).slice(0, 80),
        deckId: String(deck.id || '').slice(0, 100),
        deckName: String(deck.name || 'Mazzo One Piece').slice(0, 200),
        leader: snapshotCard(deck.cards.find(card => card.section === 'leader'), `p${player}-leader`),
        deck: cards,
        hand,
        life: [],
        lifeCount: life[player],
        characters: [],
        stage: [],
        trash: [],
        don: { deck: 10, active: 0, rested: 0 },
        mulliganUsed: false
      };
    }),
    log: [{ at, turn: 1, type: 'create', player: null, text: 'Tavolo preparato. Controlla le mani e scegli se fare mulligan, poi avvia la partita.' }],
    result: null
  };
  assertSession(session);
  return session;
}

function boardCards(player) { return [player.leader, ...player.characters, ...player.stage]; }
function allCards(player) { return [player.leader, ...ZONES.flatMap(zone => player[zone])]; }
function findCard(player, id, boardOnly = false) {
  if (player.leader.id === id) return { card: player.leader, zone: 'leader', index: 0 };
  for (const zone of boardOnly ? ['characters', 'stage'] : ZONES) {
    const index = player[zone].findIndex(card => card.id === id);
    if (index !== -1) return { card: player[zone][index], zone, index };
  }
  fail('Carta non presente nella zona richiesta.');
}

export function validateSession(session) {
  const errors = [];
  try {
    if (!session || session.version !== 1 || !text(session.id, 100) || !session.id || !text(session.createdAt, 40) || !Number.isFinite(Date.parse(session.createdAt)) || !text(session.updatedAt, 40) || !Number.isFinite(Date.parse(session.updatedAt))) errors.push('Formato del salvataggio non valido.');
    if (!integer(session?.turn, 1, 100000) || !integer(session?.activePlayer, 0, 1) || !integer(session?.firstPlayer, 0, 1) || !['setup', ...PHASES].includes(session?.phase)) errors.push('Turno o fase non validi.');
    if (!Array.isArray(session?.players) || session.players.length !== 2) return { valid: false, errors: [...errors, 'Servono esattamente due lati.'] };
    if (session.phase === 'setup' && (session.turn !== 1 || session.activePlayer !== session.firstPlayer)) errors.push('Preparazione non valida.');
    const seen = new Set();
    for (const [index, player] of session.players.entries()) {
      if (!player || !text(player.name, 80) || !text(player.deckName, 200) || !text(player.deckId, 100) || !integer(player.lifeCount, 1, 10) || typeof player.mulliganUsed !== 'boolean') { errors.push('Dati del giocatore non validi.'); continue; }
      if (ZONES.some(zone => !Array.isArray(player[zone]) || player[zone].length > 50)) { errors.push('Zone di gioco non valide.'); continue; }
      if (player.characters.length > 5 || player.stage.length > 1 || (session.phase === 'setup' && player.life.length)) errors.push('Limiti delle zone non rispettati.');
      if (!player.leader || player.leader.id !== `p${index}-leader`) { errors.push('Leader non valido.'); continue; }
      const cards = allCards(player);
      if (cards.length !== 51) errors.push('Il salvataggio ha perso o duplicato carte.');
      let attached = 0;
      for (const card of cards) {
        if (!card || !text(card.id, 100) || seen.has(card.id) || !text(card.catalogCardId, 100) || !card.catalogCardId.trim() || !text(card.cardName, 300) || !card.cardName.trim()) { errors.push('Identità delle carte non valida.'); continue; }
        seen.add(card.id);
        if (card.id !== `p${index}-leader` && !new RegExp(`^p${index}-main-(?:[0-9]|[1-4][0-9])$`).test(card.id)) errors.push('Una carta appartiene a un altro lato.');
        if (!integer(card.don, 0, 10) || typeof card.rested !== 'boolean' || !integer(card.powerModifier, -1000000, 1000000)) errors.push('Stato di una carta non valido.');
        if (card.faceUp !== undefined && typeof card.faceUp !== 'boolean') errors.push('Orientamento di una carta non valido.');
        if (!text(card.imageUrl, 2000) || !text(card.printingId, 100) || !text(card.type, 100) || !text(card.text, 10000) || !Array.isArray(card.colors) || card.colors.length > 6 || card.colors.some(color => !text(color, 30))) errors.push('Metadati di una carta non validi.');
        if ((card.cost !== null && (!Number.isFinite(card.cost) || Math.abs(card.cost) > 1000000)) || (card.power !== null && (!Number.isFinite(card.power) || Math.abs(card.power) > 1000000))) errors.push('Valori di una carta non validi.');
        attached += card.don;
      }
      for (const zone of ZONES.filter(zone => !['characters'].includes(zone))) for (const card of player[zone]) if (card?.don !== 0) errors.push('DON!! assegnati fuori da Leader o Personaggi.');
      if (!player.don || !integer(player.don.deck, 0, 10) || !integer(player.don.active, 0, 10) || !integer(player.don.rested, 0, 10) || player.don.deck + player.don.active + player.don.rested + attached !== 10) errors.push('Il totale dei DON!! deve essere 10.');
    }
    if (!Array.isArray(session.log) || session.log.length > 200 || session.log.some(entry => !entry || !text(entry.text, 1200) || !text(entry.type, 40) || !text(entry.at, 40) || !Number.isFinite(Date.parse(entry.at)) || !integer(entry.turn, 1, 100000) || (entry.player !== null && !integer(entry.player, 0, 1)))) errors.push('Registro non valido.');
    if (session.result !== null && (!session.result || ![0, 1, 'draw'].includes(session.result.winner) || !text(session.result.notes, 4000) || !text(session.result.at, 40) || !Number.isFinite(Date.parse(session.result.at)))) errors.push('Risultato non valido.');
  } catch { errors.push('Salvataggio incompleto o danneggiato.'); }
  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}

function assertSession(session) {
  const result = validateSession(session);
  if (!result.valid) fail(result.errors.join(' '));
}

function quantity(action, maximum = 50) {
  const count = action.count ?? 1;
  if (!integer(count, 1, maximum)) fail(`La quantità deve essere un intero tra 1 e ${maximum}.`);
  return count;
}

export function applyAction(session, action) {
  assertSession(session);
  if (!action || typeof action.type !== 'string') fail('Azione non valida.');
  if (session.result) fail('La partita è conclusa. Annulla il risultato per riprendere.');
  const next = clone(session);
  const at = new Date().toISOString();
  let message = '';
  let playerIndex = null;
  const needsPlayer = !['start', 'nextPhase', 'nextTurn', 'finish'].includes(action.type);
  if (needsPlayer && !integer(action.player, 0, 1)) fail('Scegli il lato A o B.');
  if (needsPlayer) playerIndex = action.player;
  const player = needsPlayer ? next.players[playerIndex] : null;
  if (next.phase === 'setup' && !['mulligan', 'start'].includes(action.type)) fail('Completa prima la preparazione e avvia la partita.');
  const name = player?.name || '';
  switch (action.type) {
    case 'start':
      if (next.phase !== 'setup') fail('La partita è già iniziata.');
      for (const side of next.players) side.life = side.deck.splice(0, side.lifeCount).reverse();
      next.phase = 'refresh';
      message = 'Life disposte dopo il mulligan. Partita iniziata: le fasi e tutte le azioni sono manuali.';
      break;
    case 'mulligan':
      if (next.phase !== 'setup' || player.mulliganUsed) fail('Il mulligan è disponibile una sola volta durante la preparazione.');
      player.deck = shuffled([...player.deck, ...player.hand]);
      player.hand = player.deck.splice(0, 5);
      player.mulliganUsed = true;
      message = `${name}: mulligan completo, nuova mano di 5 carte.`;
      break;
    case 'draw': {
      const count = quantity(action);
      if (player.deck.length < count) fail('Non ci sono abbastanza carte nel mazzo. Risolvi manualmente l’eventuale sconfitta.');
      player.hand.push(...player.deck.splice(0, count));
      message = `${name}: pesca ${count} ${count === 1 ? 'carta' : 'carte'}.`;
      break;
    }
    case 'move': {
      if (!ZONES.includes(action.to)) fail('Zona di destinazione non valida.');
      if (action.position !== undefined && !['top', 'bottom'].includes(action.position)) fail('Posizione non valida.');
      const found = findCard(player, action.cardId);
      if (found.zone === 'leader') fail('Il Leader resta nella sua area.');
      if (action.to === 'characters' && found.zone !== 'characters' && player.characters.length >= 5) fail('Ci sono già 5 Personaggi: spostane prima uno nel trash.');
      if (action.to === 'stage' && found.zone !== 'stage' && player.stage.length >= 1) fail('È già presente uno Stage: spostalo prima nel trash.');
      const [card] = player[found.zone].splice(found.index, 1);
      const hidden = ['deck', 'hand', 'life'];
      const concealed = hidden.includes(found.zone) && hidden.includes(action.to) && !(found.zone === 'life' && card.faceUp);
      if (found.zone !== action.to) {
        player.don.rested += card.don;
        card.don = 0;
        card.rested = false;
        card.powerModifier = 0;
      }
      if (['deck', 'hand', 'life'].includes(action.to)) card.faceUp = false;
      if (action.position === 'bottom' || !['deck', 'life'].includes(action.to)) player[action.to].push(card);
      else player[action.to].unshift(card);
      message = `${name}: ${concealed ? 'una carta' : card.cardName} → ${ZONE_LABELS[action.to]}${['deck', 'life'].includes(action.to) ? (action.position === 'bottom' ? ' (fondo)' : ' (cima)') : ''}.`;
      break;
    }
    case 'toggleRest': {
      const { card, zone } = findCard(player, action.cardId, true);
      if (!BOARD.includes(zone)) fail('Puoi attivare o riposare solo carte sul campo.');
      card.rested = !card.rested;
      message = `${name}: ${card.cardName} ${card.rested ? 'riposato' : 'attivo'}.`;
      break;
    }
    case 'toggleFaceUp': {
      const { card, zone } = findCard(player, action.cardId);
      if (zone !== 'life') fail('Puoi scoprire o coprire solo una carta nella zona Life.');
      card.faceUp = !card.faceUp;
      message = `${name}: una carta Life ${card.faceUp ? 'scoperta' : 'coperta'} manualmente.`;
      break;
    }
    case 'shuffle':
      if (!['deck', 'life'].includes(action.zone)) fail('Puoi mescolare solo mazzo o Life.');
      if (player[action.zone].length < 2) fail('Servono almeno 2 carte da mescolare.');
      player[action.zone] = shuffled(player[action.zone]);
      message = `${name}: ${ZONE_LABELS[action.zone]} mescolato.`;
      break;
    case 'addDon': {
      const count = quantity(action, 10);
      if (count > player.don.deck) fail('Non ci sono abbastanza DON!! nel DON!! deck.');
      player.don.deck -= count;
      player.don.active += count;
      message = `${name}: aggiunge ${count} DON!! attivi.`;
      break;
    }
    case 'restDon':
    case 'activateDon': {
      const count = quantity(action, 10);
      const from = action.type === 'restDon' ? 'active' : 'rested';
      const to = action.type === 'restDon' ? 'rested' : 'active';
      if (player.don[from] < count) fail('Non ci sono abbastanza DON!! nella zona scelta.');
      player.don[from] -= count;
      player.don[to] += count;
      message = `${name}: ${action.type === 'restDon' ? 'riposa' : 'attiva'} ${count} DON!!.`;
      break;
    }
    case 'attachDon':
    case 'detachDon': {
      const count = quantity(action, 10);
      const { card, zone } = findCard(player, action.cardId, true);
      if (!['leader', 'characters'].includes(zone)) fail('I DON!! si assegnano soltanto a Leader o Personaggi.');
      if (action.type === 'attachDon') {
        if (player.don.active < count) fail('Non ci sono abbastanza DON!! attivi da assegnare.');
        player.don.active -= count;
        card.don += count;
      } else {
        if (card.don < count) fail('La carta non ha abbastanza DON!! assegnati.');
        card.don -= count;
        player.don.rested += count;
      }
      message = `${name}: ${action.type === 'attachDon' ? 'assegna' : 'rimuove'} ${count} DON!! ${action.type === 'attachDon' ? 'a' : 'da'} ${card.cardName}.`;
      break;
    }
    case 'returnDon': {
      const count = quantity(action, 10);
      if (['active', 'rested'].includes(action.source)) {
        if (player.don[action.source] < count) fail('Non ci sono abbastanza DON!! nella zona scelta.');
        player.don[action.source] -= count;
      } else {
        const { card } = findCard(player, action.source, true);
        if (card.don < count) fail('La carta non ha abbastanza DON!! assegnati.');
        card.don -= count;
      }
      player.don.deck += count;
      message = `${name}: restituisce ${count} DON!! al DON!! deck.`;
      break;
    }
    case 'refresh': {
      let recovered = player.don.rested;
      for (const card of boardCards(player)) { recovered += card.don; card.don = 0; card.rested = false; }
      player.don.rested = 0;
      player.don.active += recovered;
      message = `${name}: Refresh manuale, carte attive e DON!! recuperati. Risolvi separatamente gli effetti che modificano il Refresh.`;
      break;
    }
    case 'power': {
      const { card, zone } = findCard(player, action.cardId, true);
      if (!['leader', 'characters'].includes(zone)) fail('Solo Leader e Personaggi hanno potere.');
      if (!integer(action.delta, -1000000, 1000000) || !integer(card.powerModifier + action.delta, -1000000, 1000000)) fail('Modifica del potere non valida.');
      card.powerModifier += action.delta;
      message = `${name}: ${card.cardName}, modificatore potere ${card.powerModifier >= 0 ? '+' : ''}${card.powerModifier}.`;
      break;
    }
    case 'nextPhase': {
      const index = PHASES.indexOf(next.phase);
      if (index === PHASES.length - 1) advanceTurn(next);
      else next.phase = PHASES[index + 1];
      message = `Turno ${next.turn}, ${next.players[next.activePlayer].name}: fase ${PHASE_LABELS[next.phase]}. Azioni da eseguire manualmente.`;
      break;
    }
    case 'nextTurn':
      advanceTurn(next);
      message = `Turno ${next.turn}: ${next.players[next.activePlayer].name}. Refresh, pesca e DON!! restano manuali.`;
      break;
    case 'finish':
      if (![0, 1, 'draw'].includes(action.winner)) fail('Seleziona il risultato della partita.');
      if (action.notes !== undefined && !text(action.notes, 4000)) fail('Le note possono contenere al massimo 4000 caratteri.');
      next.result = { winner: action.winner, notes: action.notes || '', at };
      message = action.winner === 'draw' ? 'Partita conclusa: pareggio.' : `Partita conclusa: vittoria di ${next.players[action.winner].name}.`;
      break;
    default: fail('Azione non riconosciuta.');
  }
  next.updatedAt = at;
  next.log.push({ at, turn: next.turn, type: action.type, player: playerIndex, text: message });
  next.log = next.log.slice(-200);
  assertSession(next);
  return next;
}

function advanceTurn(session) {
  if (session.turn >= 100000) fail('Limite dei turni raggiunto.');
  session.turn += 1;
  session.activePlayer = 1 - session.activePlayer;
  session.phase = 'refresh';
}
