-- F.P.T Cards — Indice per la ricerca per codice set dopo il completamento del
-- catalogo (2026-10-13: card_printings Yu-Gi-Oh! da 3.724 a ~63k righe).
--
-- lookup_card_printings_by_set_code filtra su game + upper(trim(set_code)).
-- L'indice esistente card_printings_normalized_set_code_idx è parziale
-- (where set_code <> '') e la query della funzione non ripete quel predicato,
-- quindi il planner non lo usava: scansione completa, ~80 ms a lookup, a ogni
-- scatto della Fast Scan. Un indice completo sulla stessa espressione basta.
-- Additiva: nessun dato o funzione modificati.

create index if not exists card_printings_game_upper_set_code_idx
  on public.card_printings (game, upper(trim(set_code)));

analyze public.card_printings;
