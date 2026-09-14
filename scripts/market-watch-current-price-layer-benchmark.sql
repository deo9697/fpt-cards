-- market_current_price_snapshots — benchmark OLD vs NEW per la reference
-- price pipeline, dopo aver applicato 20260914200000_market_current_price_layer.sql
-- e lanciato public.backfill_market_current_price_snapshots('<token_admin>').
--
-- Questa sessione non ha accesso a un Postgres reale: NESSUN numero qui
-- sotto è misurato, sono solo le query pronte da eseguire tu stesso nel SQL
-- Editor, prima di qualunque cutover (questa migration non lo fa).
-- Sostituisci <owner_slug>/<token_admin> con un utente reale rappresentativo
-- (idealmente lo stesso già usato per i benchmark precedenti: 2555 printing
-- owned, così il confronto è comparabile al test live che ha già dimostrato
-- 0 differenze semantiche con market_latest_prices, ma 6.9s perché quella
-- vista NON è materializzata).

-- =====================================================================
-- 1) OLD — reference price dalla pipeline whole-history (quella oggi in
--    get_market_watch_summary/list_market_watch_owned_page): scansiona
--    market_price_snapshots per intero, filtrata a owned.
-- =====================================================================
explain (analyze, buffers, format text)
with owned as (
  select ci.printing_id
  from public.collection_items ci join public.card_printings cp on cp.id = ci.printing_id
  where ci.owner_slug = '<owner_slug>' and cp.game = 'yugioh'
  group by ci.printing_id
), mapping_flags as materialized (
  select id, public.market_mapping_is_active(provider, resolution_status, provider_metadata) active
  from public.market_provider_printings
  where printing_id in (select printing_id from owned)
), eligible as materialized (
  select s.printing_id, s.provider, s.price_type, s.normalized_price, s.normalized_currency, s.captured_at
  from public.market_price_snapshots s
  join owned o on o.printing_id = s.printing_id
  join mapping_flags f on f.id = s.provider_mapping_id
  where not s.is_anomalous and s.normalized_price is not null and f.active
), preferred as (
  select distinct on (s.printing_id, s.provider) s.*
  from eligible s where s.normalized_currency = 'EUR'
  order by s.printing_id, s.provider, public.market_reference_type(s.provider, s.price_type), s.captured_at desc
)
select distinct on (printing_id) printing_id, normalized_price
from preferred order by printing_id, public.market_reference_type(provider, price_type);

-- =====================================================================
-- 2) NEW — stessa identica precedenza, dal current layer (già "un solo
--    candidato per mapping+price_type", nessuna scansione storica).
-- =====================================================================
explain (analyze, buffers, format text)
with owned as (
  select ci.printing_id
  from public.collection_items ci join public.card_printings cp on cp.id = ci.printing_id
  where ci.owner_slug = '<owner_slug>' and cp.game = 'yugioh'
  group by ci.printing_id
), mapping_flags as materialized (
  select id, public.market_mapping_is_active(provider, resolution_status, provider_metadata) active
  from public.market_provider_printings
  where printing_id in (select printing_id from owned)
), eligible as (
  select c.printing_id, c.provider, c.price_type, c.normalized_price
  from public.market_current_price_snapshots c
  join owned o on o.printing_id = c.printing_id
  join mapping_flags f on f.id = c.provider_mapping_id
  where f.active and c.normalized_currency = 'EUR'
)
select distinct on (printing_id) printing_id, normalized_price
from eligible order by printing_id, public.market_reference_type(provider, price_type);

-- Cosa guardare nel confronto:
--   - "rows" processate dal nodo Seq/Index Scan su market_price_snapshots
--     (query 1) vs market_current_price_snapshots (query 2): atteso un
--     crollo da ~150k a poche migliaia (una riga per mapping+price_type
--     owned, non per ogni giorno di storico).
--   - "Execution Time" totale.
--   - "Buffers: shared hit=" / "temp read=/written=": attesi drasticamente
--     più bassi in query 2 (niente DISTINCT ON su uno storico multi-anno).

-- =====================================================================
-- 3) Diagnostica shadow già pronta (nessun bisogno di scrivere query a
--    mano): usa direttamente la funzione della migration, sulle printing
--    REALMENTE owned di un utente, tutti i provider/price_type.
-- =====================================================================
select public.market_current_price_layer_shadow_report('<token_admin>', 'yugioh');
-- Atteso, per il criterio di correttezza (prioritario sul numero):
--   different = 0, missingCurrent = 0 dopo un backfill completo e corretto.
--   Se missingCurrent > 0: significa che backfill_market_current_price_snapshots
--   non è ancora stato eseguito, o è stato eseguito PRIMA che market-sync
--   scrivesse alcuni snapshot (rilancialo: è idempotente, sicuro rieseguirlo).

-- =====================================================================
-- 4) Verifica trigger dal vivo (facoltativa, prima di fidarsi ciecamente
--    del layer su dati reali): controlla che il current layer coincida
--    DAVVERO con "ultimo non anomalo" per un campione di mapping.
-- =====================================================================
select c.provider_mapping_id, c.price_type, c.snapshot_id, c.captured_at,
  (select s.id from public.market_price_snapshots s
   where s.provider_mapping_id = c.provider_mapping_id and s.price_type = c.price_type and not s.is_anomalous
   order by s.captured_at desc, s.id desc limit 1) as expected_snapshot_id
from public.market_current_price_snapshots c
limit 100;
-- snapshot_id ed expected_snapshot_id devono sempre coincidere.

-- Target indicativo dal task (non una garanzia): la query 2 idealmente
-- <<100-200ms sul dataset reale. La correttezza (shadow different=0) resta
-- il criterio primario, non il numero.
