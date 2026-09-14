-- F.P.T Cards — Market Watch P0 performance, step 2: get_market_watch_summary().
--
-- AUDIT (codice presente, non note vecchie): la definizione live più recente
-- è in supabase/migrations/20260911145101_market_watch_owned_pagination.sql
-- (nessuna migration successiva la ridefinisce — 20260912180000 e
-- 20260914090000 la citano solo nei commenti). Benchmark reale precedente:
-- get_market_watch_summary ≈ 0.88s warm, shared hit ~64k, temp read/write
-- significativo.
--
-- Campo per campo, cosa serve davvero:
--   portfolioValue.current/complete -> SOLO il prezzo CORRENTE (un singolo
--     reference price per printing owned), nessuno storico.
--   catalogPriceFloor               -> stesso reference price corrente,
--     aggregato per catalog_card_id (MIN), più un flag booleano dai
--     metadata di mapping della printing vincente. Nessuno storico.
--   confirmCount/aggregatePendingCount -> SOLI metadata di mapping
--     (market_provider_printings.resolution_status/provider_metadata) per
--     le printing owned — MAI un prezzo, MAI market_price_snapshots. Il
--     codice attuale lo fa già correttamente in una CTE indipendente
--     (confirm_counts), verificato in questo audit: non tocca
--     mapping_flags/eligible_snapshots/preferred/reference — nessun
--     cambiamento necessario qui (principio E del task già rispettato).
--   lastSync                        -> aggregato indipendente su
--     market_provider_sync_runs, già minimo, nessun cambiamento necessario.
--
-- ROOT CAUSE del costo residuo: mapping_flags viene costruita chiamando
-- public.market_mapping_is_active() su TUTTE le righe di
-- market_provider_printings (l'intero catalogo, non le sole printing
-- dell'utente) — la STESSA classe di bug già trovata e corretta in
-- list_market_watch_owned_page (vedi 20260914090000). eligible_snapshots è
-- già correttamente filtrata su owned (join owned o on o.printing_id =
-- s.printing_id), quindi mapping_flags non è mai joinata a una printing_id
-- fuori da owned in nessun punto della funzione: restringerla non cambia
-- alcun risultato, elimina solo il lavoro sprecato sul resto del catalogo.
--
-- Inoltre: mapping_flags calcola oggi anche la colonna 'derived' — ma
-- get_market_watch_summary non ha ALCUN campo storico (24h/7d/30d), quindi
-- 'derived' non viene MAI letta da eligible_snapshots (che filtra solo
-- "f.active"). È un calcolo morto, rimosso qui (mai una scrittura, mai un
-- filtro cambiato — solo un'espressione che non veniva mai usata).
--
-- market_latest_prices/market_active_price_snapshots NON sostituiscono la
-- fonte del reference price qui, per lo stesso motivo per cui non l'hanno
-- sostituita in list_market_watch_owned_page: la loro semantica esatta
-- (sono già pre-filtrate per mapping attivo? con quale freschezza sono
-- aggiornate?) non è verificabile da questa sessione (nessun accesso DB
-- live, e le due viste non sono definite in nessuna migration di questo
-- repo — probabile oggetto live non tracciato). Prova concreta della
-- prudenza necessaria: list_collection_share_requests (supabase-collection-
-- share-request-prices.sql) e la retired list_market_watch (20260908203706)
-- usano market_latest_prices/market_active_price_snapshots SENZA rifiltrare
-- per mapping attivo, mentre get_market_watch_summary/list_market_watch_
-- owned_page (più recenti) rifiltrano sempre esplicitamente via
-- mapping_flags — due presupposti diversi nello stesso repo, non
-- riconciliabili senza ispezionare la definizione live. Restare su
-- market_price_snapshots (raw) + mapping_flags espliciti è l'unica opzione
-- provabilmente equivalente al comportamento attuale.
--
-- Nessun nuovo indice: l'indice su market_provider_printings(printing_id)
-- già aggiunto da 20260914090000 (per lo stesso pattern "where printing_id
-- in (...)") copre anche l'uso introdotto qui.
--
-- NON tocca list_market_watch_owned_page/list_market_watch_extra/
-- list_market_confirm_queue/ygo_market_variants/ygo_market_variant_price_
-- shadow/market-sync/resolver Cardmarket/cron/alert/notifiche. Payload JSON
-- (chiavi, tipi, valori) identico per lo stesso input — verificato con un
-- confronto vecchia/nuova logica su dataset sintetico (vedi test).

begin;

create or replace function public.get_market_watch_summary(p_token text, p_game text default 'yugioh')
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token); result jsonb;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;

  with owned as (
    select ci.printing_id, sum(ci.quantity_owned)::integer quantity
    from public.collection_items ci join public.card_printings cp on cp.id = ci.printing_id
    where ci.owner_slug = me and cp.game = p_game group by ci.printing_id
  ), mapping_flags as materialized (
    -- Ristretto alle sole printing owned (root cause del costo residuo:
    -- prima scansionava/valutava market_mapping_is_active() sull'intero
    -- catalogo). 'derived' rimosso: mai letto in questa funzione (nessun
    -- campo storico qui, a differenza di owned_page/extra).
    select id, public.market_mapping_is_active(provider, resolution_status, provider_metadata) active
    from public.market_provider_printings
    where printing_id in (select printing_id from owned)
  ), eligible_snapshots as materialized (
    select s.printing_id, s.provider, s.price_type, s.normalized_price, s.normalized_currency, s.captured_at
    from public.market_price_snapshots s
    join owned o on o.printing_id = s.printing_id
    join mapping_flags f on f.id = s.provider_mapping_id
    where not s.is_anomalous and s.normalized_price is not null and f.active
  ), preferred as (
    select distinct on (s.printing_id, s.provider) s.*
    from eligible_snapshots s where s.normalized_currency = 'EUR'
    order by s.printing_id, s.provider, public.market_reference_type(s.provider, s.price_type), s.captured_at desc
  ), reference as (
    select distinct on (printing_id) printing_id, normalized_price
    from preferred order by printing_id, public.market_reference_type(provider, price_type)
  ), portfolio as (
    select o.printing_id, o.quantity, r.normalized_price
    from owned o left join reference r on r.printing_id = o.printing_id
  ), catalog_floor as (
    -- Invariato: prezzo minimo per carta logica tra le printing owned, con
    -- il flag "era aggregato" — stesso criterio di fallback/floor di prima.
    select distinct on (cp.catalog_card_id) cp.catalog_card_id, r.normalized_price as reference_price,
      (coalesce(cm.provider_metadata->>'resolverStatus', cm.resolution_status) = 'PROVIDER_AGGREGATE') as is_aggregate
    from owned o
    join public.card_printings cp on cp.id = o.printing_id
    join reference r on r.printing_id = o.printing_id
    left join public.market_provider_printings cm on cm.printing_id = o.printing_id and cm.provider = 'cardmarket' and cm.variant_key = 'default'
    where r.normalized_price is not null
    order by cp.catalog_card_id, r.normalized_price asc
  ), confirm_counts as (
    -- Invariato: già indipendente dalla pipeline prezzi (nessun riferimento
    -- a mapping_flags/eligible_snapshots/preferred/reference), audit
    -- confermato — principio E del task già rispettato prima di questa
    -- migration, nessun cambiamento necessario qui.
    select
      count(*) filter (where cm.resolution_status <> 'manual' and (cm.provider_metadata->>'reason' = 'provider_rarity_mismatch' or coalesce(cm.provider_metadata->>'resolverStatus', cm.resolution_status) = 'AMBIGUOUS')) confirm_count,
      count(*) filter (where coalesce(cm.provider_metadata->>'resolverStatus', cm.resolution_status) = 'PROVIDER_AGGREGATE' and (
        (case when jsonb_typeof(cm.provider_metadata->'evidence'->'candidates') = 'array' then jsonb_array_length(cm.provider_metadata->'evidence'->'candidates') > 0 else false end)
        or cm.provider_metadata->'evidence'->>'providerProductId' is not null
      )) aggregate_pending_count
    from owned o
    join public.market_provider_printings cm on cm.printing_id = o.printing_id and cm.provider = 'cardmarket' and cm.variant_key = 'default'
  )
  select jsonb_build_object(
    'portfolioValue', jsonb_build_object(
      'current', coalesce(sum(p.normalized_price * p.quantity) filter (where p.normalized_price is not null), 0),
      'complete', (sum(p.quantity) filter (where p.normalized_price is not null))::numeric >= 0.9 * nullif(sum(p.quantity), 0)
    ),
    'confirmCount', coalesce((select confirm_count from confirm_counts), 0),
    'aggregatePendingCount', coalesce((select aggregate_pending_count from confirm_counts), 0),
    'catalogPriceFloor', coalesce((select jsonb_object_agg(catalog_card_id, jsonb_build_object('referencePrice', reference_price, 'isAggregate', is_aggregate)) from catalog_floor), '{}'::jsonb),
    'lastSync', (select max(finished_at) from public.market_provider_sync_runs where status in ('succeeded', 'partial'))
  ) into result from portfolio p;

  return coalesce(result, jsonb_build_object('portfolioValue', jsonb_build_object('current', 0, 'complete', false), 'confirmCount', 0, 'aggregatePendingCount', 0, 'catalogPriceFloor', '{}'::jsonb, 'lastSync', null));
end;
$$;

revoke all on function public.get_market_watch_summary(text,text) from public, anon, authenticated;
grant execute on function public.get_market_watch_summary(text,text) to anon, authenticated;

commit;
