export const YUGIOH_SECTIONS = ['main', 'extra', 'side'];
export const YUGIOH_LABELS = { main: 'Main Deck', extra: 'Extra Deck', side: 'Side Deck' };

const MAIN_MIN = 40;
const MAIN_MAX = 60;
const EXTRA_MAX = 15;
const SIDE_MAX = 15;
const BAN_COPY_LIMIT = { forbidden: 0, limited: 1, 'semi-limited': 2 };
const DEFAULT_COPY_LIMIT = 3;

export function validateYugiohDeck(deck) {
  const cards = deck?.cards || [];
  const mainCount = sumSection(cards, 'main');
  const extraCount = sumSection(cards, 'extra');
  const sideCount = sumSection(cards, 'side');
  const errors = [];
  if (mainCount < MAIN_MIN || mainCount > MAIN_MAX) errors.push(`Il Main Deck deve avere tra ${MAIN_MIN} e ${MAIN_MAX} carte (attuali: ${mainCount})`);
  if (extraCount > EXTRA_MAX) errors.push(`Extra Deck: massimo ${EXTRA_MAX} carte (attuali: ${extraCount})`);
  if (sideCount > SIDE_MAX) errors.push(`Side Deck: massimo ${SIDE_MAX} carte (attuali: ${sideCount})`);
  const grouped = new Map();
  for (const card of cards) {
    const entry = grouped.get(card.catalogCardId) || { quantity: 0, cardName: card.cardName, banTcg: card.banTcg || '' };
    entry.quantity += Number(card.quantity || 0);
    grouped.set(card.catalogCardId, entry);
  }
  for (const entry of grouped.values()) {
    const limit = BAN_COPY_LIMIT[entry.banTcg] ?? DEFAULT_COPY_LIMIT;
    if (entry.quantity > limit) errors.push(`${entry.cardName}: massimo ${limit} copie (attuali: ${entry.quantity})`);
  }
  return {
    valid: !errors.length,
    errors,
    counts: {
      main: { count: mainCount, min: MAIN_MIN, max: MAIN_MAX },
      extra: { count: extraCount, max: EXTRA_MAX },
      side: { count: sideCount, max: SIDE_MAX }
    }
  };
}

function sumSection(cards, section) { return cards.filter(card => card.section === section).reduce((sum, card) => sum + Number(card.quantity || 0), 0); }
