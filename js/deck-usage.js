// Identità carta↔mazzo e indice "in quali mazzi è usata" per la Raccolta.
// Separati da decks.js (~110 KB più l'export immagini) così Raccolta e app.js
// non trascinano l'intero modulo Mazzi nel primo caricamento. Codice spostato
// invariato; decks.js li importa da qui e re-esporta deckUsageIndex e
// deckNamesForCollectionItem per i chiamanti esistenti.
import { canonicalCatalogCardId } from './cards.js';

export function deckCardIdentityKey(card) { const game = card?.game || 'yugioh', id = canonicalCatalogCardId(card?.catalogCardId, game), name = normalizeDeckCardName(card?.cardName); return id ? `id:${game}:${id}` : `name:${game}:${name}`; }

// Reverse of deckAvailability: for a Raccolta card, which of the owner's own
// mazzi already use it. Keyed with the same identity as deckAvailability so
// a card matches a deck slot regardless of which printing is on file.
export function deckUsageIndex(decks, ownerSlug, game) {
  const index = new Map();
  for (const deck of decks || []) {
    if (deck.game !== game || (deck.ownerSlug || '') !== ownerSlug) continue;
    for (const card of deck.cards || []) {
      const key = deckCardIdentityKey({ ...card, game });
      const names = index.get(key) || new Set();
      names.add(deck.name);
      index.set(key, names);
    }
  }
  return index;
}

export function deckNamesForCollectionItem(index, item) {
  return [...(index?.get(deckCardIdentityKey(item)) || [])];
}
export function normalizeDeckCardName(value) { return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/gi, ' ').trim().toLowerCase(); }
