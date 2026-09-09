export const ONE_PIECE_SECTIONS = ['leader', 'main', 'don'];
export const ONE_PIECE_LABELS = { leader: 'Leader', main: 'Main Deck', don: 'DON!!' };

const LEADER_COUNT = 1;
const MAIN_DECK_SIZE = 50;
export const DON_DECK_SIZE = 10;
const MAIN_CARD_COPY_LIMIT = 4;

// Le 10 carte DON!! non si scelgono a mano come Leader/Main (P1.0): il Deck
// Builder le aggiunge da solo cercando questo termine nel catalogo. Se il
// catalogo non è ancora sincronizzato la ricerca torna vuota — nessun errore,
// il riepilogo resta semplicemente a 0/10 finché il sync non gira.
export const DON_SEARCH_QUERY = 'DON!!';
export function isDonCard(card) {
  const type = String(card?.type || '').toLowerCase();
  if (type === 'don' || type.includes('don')) return true;
  return /^don!!/i.test(String(card?.name || '').trim());
}
// Usato dall'import OPTCGSim (P1.1) per capire se una riga risolta va nella
// sezione Leader o Main — OPTCGSim non marca la riga del Leader in alcun modo,
// quindi la distinzione viene fatta guardando il tipo carta risolto dal
// catalogo, non il testo importato.
export function isLeaderCard(card) { return String(card?.type || '').toLowerCase().includes('leader'); }

// Formato OPTCGSim: una carta logica per riga, es. "4xOP17-086" (tollera
// "4x OP17-086", "4 OP17-086" o la riga nuda "OP17-086" per quantità 1).
// Righe che non assomigliano a un codice carta vengono ignorate in silenzio
// (spazi vuoti, intestazioni eventuali) — solo i codici RISOLTI ma non
// trovati nel catalogo finiscono nell'elenco "non riconosciuti" mostrato
// all'utente (decks.js).
const OPTCG_LINE_RE = /^(\d{1,3})\s*[x×]?\s+([A-Za-z0-9]+-[A-Za-z0-9]+)$/i;
const OPTCG_COMPACT_LINE_RE = /^(\d{1,3})\s*[x×]\s*([A-Za-z0-9]+-[A-Za-z0-9]+)$/i;
const OPTCG_BARE_CODE_RE = /^([A-Za-z0-9]+-[A-Za-z0-9]+)$/i;
export function parseOptcgList(text) {
  const merged = new Map();
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const match = line.match(OPTCG_COMPACT_LINE_RE) || line.match(OPTCG_LINE_RE);
    const bare = !match && line.match(OPTCG_BARE_CODE_RE);
    if (!match && !bare) continue;
    const code = (match ? match[2] : bare[1]).toUpperCase();
    const quantity = match ? Math.max(1, Number(match[1])) : 1;
    const existing = merged.get(code);
    if (existing) existing.quantity += quantity; else merged.set(code, { code, quantity });
  }
  return [...merged.values()];
}

// Nessuna dipendenza dal DB: colori/costo/potere non sono ancora persistiti
// (vedi STEP E), quindi il controllo colore Leader si applica solo se le
// carte in memoria portano già `colors` — altrimenti non blocca nulla.
export function validateOnePieceDeck(deck) {
  const cards = deck?.cards || [];
  const leaderCards = cards.filter(card => card.section === 'leader');
  const mainCards = cards.filter(card => card.section === 'main');
  const donCards = cards.filter(card => card.section === 'don');
  const leaderCount = sumQuantity(leaderCards);
  const mainCount = sumQuantity(mainCards);
  const donCount = sumQuantity(donCards);
  const errors = [];
  if (leaderCount !== LEADER_COUNT) errors.push(`Serve esattamente ${LEADER_COUNT} Leader (attuali: ${leaderCount})`);
  if (mainCount !== MAIN_DECK_SIZE) errors.push(`Il Main Deck deve contenere ${MAIN_DECK_SIZE} carte (attuali: ${mainCount})`);
  if (donCount !== DON_DECK_SIZE) errors.push(`Servono ${DON_DECK_SIZE} carte DON!! (attuali: ${donCount})`);
  // Il limite è per carta logica (catalogCardId), non per riga: 2x regular +
  // 2x parallel dello stesso catalogCardId sono 4 copie della stessa carta
  // ai fini di questo controllo, non 2+2 carte "diverse" (Fase 4.1).
  const mainByCard = new Map();
  for (const card of mainCards) {
    const entry = mainByCard.get(card.catalogCardId) || { cardName: card.cardName, quantity: 0 };
    entry.quantity += Number(card.quantity || 0);
    mainByCard.set(card.catalogCardId, entry);
  }
  for (const entry of mainByCard.values()) if (entry.quantity > MAIN_CARD_COPY_LIMIT) errors.push(`${entry.cardName}: massimo ${MAIN_CARD_COPY_LIMIT} copie (attuali: ${entry.quantity})`);
  const leaderColors = leaderCards[0]?.colors;
  if (Array.isArray(leaderColors) && leaderColors.length) {
    for (const card of mainCards) {
      if (Array.isArray(card.colors) && card.colors.length && !card.colors.some(color => leaderColors.includes(color))) errors.push(`${card.cardName}: colore non compatibile con il Leader`);
    }
  }
  return {
    valid: !errors.length,
    errors,
    counts: {
      leader: { count: leaderCount, target: LEADER_COUNT },
      main: { count: mainCount, target: MAIN_DECK_SIZE },
      don: { count: donCount, target: DON_DECK_SIZE }
    }
  };
}

function sumQuantity(cards) { return cards.reduce((sum, card) => sum + Number(card.quantity || 0), 0); }
