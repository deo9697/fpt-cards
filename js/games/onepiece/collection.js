// Filtri Raccolta dichiarati dall'adapter One Piece: collection.js resta
// generico e li renderizza da qui, senza `if (game === 'onepiece')` sparsi.
// facetFiltersView() in collection.js già gestisce un array vuoto tornando
// '' (niente riga filtri renderizzata) — svuotare qui basta per togliere
// Set/Rarità/Colore/Tipo carta/Costo/Potere/Counter dalla Raccolta One Piece
// su richiesta esplicita dell'utente (2026-09-09: troppi filtri, tenere solo
// ricerca/disponibilità/ordina/griglia-lista). Riattivabili in futuro
// rimettendo le definizioni sotto, la logica del motore filtri non cambia.
export const ONE_PIECE_COLLECTION_FILTERS = [];
