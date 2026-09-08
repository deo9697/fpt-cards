// Filtri Raccolta dichiarati dall'adapter One Piece: collection.js resta
// generico e li renderizza da qui, senza `if (game === 'onepiece')` sparsi.
// `ready:false` = il campo non è ancora persistito su un item di raccolta
// (serve prima il catalog sync OPTCG → Supabase, Fase 2-4): il filtro esiste
// già in UI ma resta disabilitato finché getValue non trova mai un valore.
export const ONE_PIECE_COLLECTION_FILTERS = [
  { key: 'setCode', label: 'Set', ready: true, getValue: item => String(item.setCode || '').trim().toUpperCase() },
  { key: 'rarity', label: 'Rarità', ready: true, getValue: item => String(item.rarity || '').trim() },
  { key: 'color', label: 'Colore', ready: false, getValue: item => item.color || '' },
  { key: 'cardType', label: 'Tipo carta', ready: false, getValue: item => item.cardType || '' },
  { key: 'cost', label: 'Costo', ready: false, getValue: item => item.cost ?? '' },
  { key: 'power', label: 'Potere', ready: false, getValue: item => item.power ?? '' },
  { key: 'counter', label: 'Counter', ready: false, getValue: item => item.counter ?? '' }
];
