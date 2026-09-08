// Filtri Raccolta dichiarati dall'adapter One Piece: collection.js resta
// generico e li renderizza da qui, senza `if (game === 'onepiece')` sparsi.
// Attivi da Fase 4: list_my_collection/list_team_collection restituiscono
// game_metadata (Fase 4.7), e app.js's mapCollectionItem() lo scompone in
// colors/cardType/cost/power/counter sull'item (Fase 4.8).
//
// `color` è `multi: true`: un Leader può avere più colori (es. "Red/Green"),
// quindi getValue restituisce un array — collection.js sa già trattare un
// facet `multi` come "il valore selezionato deve comparire nell'array",
// invece della normale uguaglianza stretta usata dagli altri filtri.
export const ONE_PIECE_COLLECTION_FILTERS = [
  { key: 'setCode', label: 'Set', ready: true, getValue: item => String(item.setCode || '').trim().toUpperCase() },
  { key: 'rarity', label: 'Rarità', ready: true, getValue: item => String(item.rarity || '').trim() },
  { key: 'color', label: 'Colore', ready: true, multi: true, getValue: item => Array.isArray(item.colors) ? item.colors : [] },
  { key: 'cardType', label: 'Tipo carta', ready: true, getValue: item => item.cardType || '' },
  { key: 'cost', label: 'Costo', ready: true, getValue: item => item.cost ?? '' },
  { key: 'power', label: 'Potere', ready: true, getValue: item => item.power ?? '' },
  { key: 'counter', label: 'Counter', ready: true, getValue: item => item.counter ?? '' }
];
