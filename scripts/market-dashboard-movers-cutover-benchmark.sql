-- Market Watch — benchmark OLD vs NEW per il cutover di
-- list_market_dashboard_movers (supabase/migrations/20260916100000_market_
-- dashboard_movers_current_price_cutover.sql). Nessun numero qui è misurato:
-- questa sessione non ha accesso a un Postgres reale. Sostituisci
-- <token_admin> con un utente reale rappresentativo (idealmente lo stesso
-- già usato per gli altri benchmark del current layer: 2578 printing owned).

-- =====================================================================
-- 1) OLD vs NEW — applica la migration PRIMA di eseguire "2) NEW".
-- =====================================================================
explain (analyze, buffers, format text)
select public.list_market_dashboard_movers('<token_admin>', 'yugioh');
-- (eseguila una volta PRIMA di applicare la migration per il baseline "OLD",
-- poi di nuovo DOPO per "NEW" — stessa funzione, stesso utente).

-- Cosa guardare: il nodo che oggi scansiona market_active_price_snapshots
-- (quindi market_price_snapshots, storico completo filtrato solo per
-- mapping attivo, senza alcun limite temporale nella query stessa) per le
-- sole printing owned deve sparire, sostituito da un lookup su
-- market_current_price_snapshots via market_current_price_snapshots_
-- printing_idx (poche righe per printing invece dell'intero storico).
-- "Execution Time" atteso in netto calo, stesso ordine di grandezza già
-- misurato per le altre 3 RPC cutover.

-- =====================================================================
-- 2) Verifica di correttezza post-cutover (prioritaria sul numero):
--    riconciliazione manuale, list_market_dashboard_movers non ha una RPC
--    shadow dedicata — confronta il risultato PRIMA e DOPO la migration per
--    lo stesso utente/momento: deve restare IDENTICO (stessi printingId,
--    stesso ordine, stessi referencePrice/positiveChange), a meno che nel
--    frattempo sia arrivato un nuovo snapshot reale (finestra di 48h).
-- =====================================================================
-- PRIMA di applicare la migration:
--   select public.list_market_dashboard_movers('<token_admin>', 'yugioh');
-- Salva l'output, poi applica la migration ed esegui di nuovo la stessa
-- query: il jsonb deve coincidere campo per campo (salvo un eventuale nuovo
-- snapshot arrivato nel frattempo, che cambierebbe comunque ENTRAMBE le
-- pipeline se rieseguite sull'output storico aggiornato).

-- =====================================================================
-- 3) Equivalenza strutturale con le altre 3 RPC già cutover: il current
--    layer per le stesse printing owned è lo stesso dataset già validato
--    dal report shadow generale (non specifico a dashboard_movers, ma sulla
--    stessa fonte dati) — se quel report è pulito, lo è anche l'input di
--    questa RPC.
-- =====================================================================
select public.market_current_price_layer_shadow_report('<token_admin>', 'yugioh');
