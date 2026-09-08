export const ONE_PIECE_SECTIONS = ['leader', 'main', 'don'];
export const ONE_PIECE_LABELS = { leader: 'Leader', main: 'Main Deck', don: 'DON!!' };

const LEADER_COUNT = 1;
const MAIN_DECK_SIZE = 50;
const DON_DECK_SIZE = 10;
const MAIN_CARD_COPY_LIMIT = 4;

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

// Usato sia dal validator sopra sia dal filtro automatico del Deck Builder
// (decks.js) quando si cercano carte da aggiungere al Main con un Leader già
// scelto. Nessun colore noto su uno dei due lati = non blocca nulla (dati
// mancanti, non un vero conflitto).
export function cardMatchesLeaderColor(card, leaderColors) {
  if (!Array.isArray(leaderColors) || !leaderColors.length) return true;
  if (!Array.isArray(card?.colors) || !card.colors.length) return true;
  return card.colors.some(color => leaderColors.includes(color));
}
