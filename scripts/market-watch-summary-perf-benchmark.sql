-- get_market_watch_summary() — benchmark before/after per la migration
-- 20260914150000_market_watch_summary_perf.sql.
--
-- Questa sessione non ha accesso a un Postgres reale (nessuna CLI/
-- credenziali): questo file NON contiene numeri misurati, solo le query
-- pronte da eseguire tu stesso nel SQL Editor del Dashboard Supabase,
-- PRIMA e DOPO aver applicato la migration, per confrontare onestamente.
-- Sostituisci '<token_admin>' con un session token reale (member->slug via
-- session_member) di un utente con una raccolta rappresentativa (idealmente
-- la stessa usata per il benchmark precedente di list_market_watch_owned_page).

-- =====================================================================
-- 1) EXPLAIN (ANALYZE, BUFFERS) sulla funzione intera — prima di applicare
--    la migration, per avere il baseline "prima".
-- =====================================================================
explain (analyze, buffers, format text)
select public.get_market_watch_summary('<token_admin>', 'yugioh');

-- Applica qui la migration 20260914150000_market_watch_summary_perf.sql,
-- poi ripeti lo stesso EXPLAIN per il "dopo":
explain (analyze, buffers, format text)
select public.get_market_watch_summary('<token_admin>', 'yugioh');

-- Cosa guardare nel confronto prima/dopo:
--   - "Buffers: shared hit=" sul nodo Seq Scan su market_provider_printings
--     (o sul suo Bitmap/Index Scan, se il planner sceglie l'indice
--     market_provider_printings_printing_id_idx già presente da
--     20260914090000): deve scendere drasticamente, essendo ora filtrato
--     a "owned" invece di scansionare l'intero catalogo.
--   - "temp read=/temp written=" complessivo della query: atteso in calo
--     (meno righe materializzate in mapping_flags).
--   - Tempo totale "Execution Time".

-- =====================================================================
-- 2) Isolamento del solo costo di mapping_flags — utile per attribuire il
--    guadagno specificamente al fix (root cause), non solo osservare il
--    tempo totale della funzione.
-- =====================================================================
-- PRIMA (whole-catalog, quello che la funzione live faceva prima del fix):
explain (analyze, buffers)
select id, public.market_mapping_is_active(provider, resolution_status, provider_metadata) active
from public.market_provider_printings;

-- DOPO (ristretto a owned di un utente specifico — sostituisci lo slug):
explain (analyze, buffers)
with owned as (
  select ci.printing_id
  from public.collection_items ci join public.card_printings cp on cp.id = ci.printing_id
  where ci.owner_slug = '<owner_slug>' and cp.game = 'yugioh'
  group by ci.printing_id
)
select id, public.market_mapping_is_active(provider, resolution_status, provider_metadata) active
from public.market_provider_printings
where printing_id in (select printing_id from owned);

-- =====================================================================
-- 3) Confronto payload (prima/dopo devono coincidere byte per byte per lo
--    stesso utente) — esegui PRIMA di applicare la migration e salva il
--    risultato, poi riesegui DOPO e confronta manualmente (o con un diff):
-- =====================================================================
select public.get_market_watch_summary('<token_admin>', 'yugioh');

-- =====================================================================
-- 4) pg_stat_statements (se disponibile) — media/massimo reali su un
--    campione di chiamate, stesso identico approccio già usato per
--    list_market_watch_owned_page (vedi docs/market-loading-performance-2026-09-08.md).
-- =====================================================================
select calls, mean_exec_time, max_exec_time, rows
from pg_stat_statements
where query ilike '%get_market_watch_summary%'
order by calls desc
limit 5;

-- Target indicativo dal task (non una garanzia): <300-400ms warm sul
-- dataset reale, eliminazione del temp spill osservato nel benchmark
-- precedente (~0.88s warm, shared hit ~64k). La correttezza (stesso
-- payload) resta il criterio primario, non il numero.
