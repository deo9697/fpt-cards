-- Market Watch — benchmark OLD vs NEW per il cutover dei 3 reader
-- (20260914210000_market_watch_current_price_cutover.sql). Nessun numero
-- qui è misurato: questa sessione non ha accesso a un Postgres reale.
-- Sostituisci <owner_slug>/<token_admin> con un utente reale rappresentativo
-- (idealmente lo stesso già usato per il benchmark del current layer: 2578
-- printing owned, confrontabile col report shadow già fornito).

-- =====================================================================
-- 1) get_market_watch_summary — OLD (storico) vs NEW (current layer).
--    Applica la migration PRIMA di eseguire la query "2) NEW".
-- =====================================================================
-- OLD: rilancia la query di scripts/market-watch-summary-perf-benchmark.sql
-- sezione 2 ("isolamento del solo costo di mapping_flags") come baseline
-- pre-cutover, oppure semplicemente:
explain (analyze, buffers, format text)
select public.get_market_watch_summary('<token_admin>', 'yugioh');
-- (eseguila una volta PRIMA di applicare questa migration per il baseline
-- "OLD", poi di nuovo DOPO per "NEW" — stessa funzione, stesso utente).

-- Cosa guardare: righe attraversate per la CTE eligible_current/eligible_
-- snapshots (atteso crollo da ~150k a poche migliaia — stesso ordine di
-- grandezza del report reale già fornito: 150.022 vs 17.186), "Execution
-- Time", "Buffers: shared hit=", "temp read=/written=" (atteso a zero o
-- quasi, niente più external merge).

-- =====================================================================
-- 2) list_market_watch_owned_page — sort=value/price/change, limit=60,
--    offset=0 (il caso che oggi va in timeout secondo l'audit fornito).
-- =====================================================================
explain (analyze, buffers, format text)
select public.list_market_watch_owned_page('<token_admin>', 'yugioh', 60, 0, 'value', null);

explain (analyze, buffers, format text)
select public.list_market_watch_owned_page('<token_admin>', 'yugioh', 60, 0, 'price', null);

explain (analyze, buffers, format text)
select public.list_market_watch_owned_page('<token_admin>', 'yugioh', 60, 0, 'change', null);

-- Cosa guardare: il nodo che oggi scansiona market_price_snapshots per
-- l'intero insieme owned (FASE A, branch price/value/change) deve sparire
-- per value/price (sostituito da uno scan/index lookup su
-- market_current_price_snapshots, poche migliaia di righe) e ridursi per
-- change (resta uno scan storico, ma SOLO per il 24h, non più anche per il
-- reference price). "Execution Time" atteso molto sotto la soglia di
-- statement timeout che oggi scatta prima di arrivare alla pagina.

-- =====================================================================
-- 3) list_market_watch_extra — nessun parametro di sort, ma stesso
--    principio (reference/lowest/providers dal current layer).
-- =====================================================================
explain (analyze, buffers, format text)
select public.list_market_watch_extra('<token_admin>', 'yugioh');

-- =====================================================================
-- 4) Verifica di correttezza post-cutover (prioritaria sul numero): la
--    shadow diagnostica di 20260914200000 confronta la stessa identica
--    pipeline "legacy" (storico) contro il current layer — se il cutover è
--    corretto, questo report deve restare invariato rispetto a quello già
--    fornito (2568 equal, 0 different, 0 missingCurrent/missingLegacy, 10
--    bothMissing) anche DOPO aver applicato il cutover, perché il cutover
--    non tocca il current layer stesso, solo chi lo legge.
-- =====================================================================
select public.market_current_price_layer_shadow_report('<token_admin>', 'yugioh');

-- Target indicativo dal task (non una garanzia, la correttezza viene
-- prima): niente più scansione whole-history per il prezzo corrente,
-- niente external merge globale, storico limitato alle sole printing
-- necessarie, forte riduzione delle righe processate — coerente con la
-- differenza già misurata sul current layer da solo (914.7ms / 149.986
-- righe -> 108.6ms / 15.566 righe).
