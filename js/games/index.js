import { searchCards as searchYugiohCards, findCard as findYugiohCard } from './yugioh/catalog.js';
import { YUGIOH_SECTIONS, YUGIOH_LABELS, validateYugiohDeck } from './yugioh/rules.js';
import { searchCards as searchOnePieceCards, findCard as findOnePieceCard, findCardById as findOnePieceCardById } from './onepiece/catalog.js';
import { ONE_PIECE_SECTIONS, ONE_PIECE_LABELS, validateOnePieceDeck, DON_DECK_SIZE, DON_SEARCH_QUERY, isDonCard, isLeaderCard, parseOptcgList } from './onepiece/rules.js';
import { ONE_PIECE_COLLECTION_FILTERS } from './onepiece/collection.js';

const ADAPTERS = {
  yugioh: {
    searchCards: searchYugiohCards,
    findCard: findYugiohCard,
    validateDeck: validateYugiohDeck,
    sections: YUGIOH_SECTIONS,
    labels: YUGIOH_LABELS,
    collectionFilters: []
  },
  onepiece: {
    searchCards: searchOnePieceCards,
    findCard: findOnePieceCard,
    findCardById: findOnePieceCardById,
    validateDeck: validateOnePieceDeck,
    sections: ONE_PIECE_SECTIONS,
    labels: ONE_PIECE_LABELS,
    collectionFilters: ONE_PIECE_COLLECTION_FILTERS,
    donDeckSize: DON_DECK_SIZE,
    donSearchQuery: DON_SEARCH_QUERY,
    isDonCard,
    isLeaderCard,
    parseOptcgList
  }
};

export function getGameAdapter(game) { return ADAPTERS[game] || ADAPTERS.yugioh; }
