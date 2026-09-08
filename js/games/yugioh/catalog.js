// Sottile wrapper sul motore ygoprodeck già in js/cards.js: qui non
// riscriviamo la logica di ricerca/matching, solo la esponiamo come adapter
// senza il parametro `game` (il motore resta condiviso per gli altri usi
// yugioh-only già presenti in cards.js: findCardById, reconcileCatalogCard...).
import { searchCards as searchYugiohCards, findCard as findYugiohCard } from '../../cards.js';

export function searchCards(query) { return searchYugiohCards(query, 'yugioh'); }
export function findCard(name) { return findYugiohCard(name, 'yugioh'); }
