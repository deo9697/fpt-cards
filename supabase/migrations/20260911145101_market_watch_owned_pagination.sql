-- F.P.T Cards — Market Watch: paginazione server-side reale della tab
-- Raccolta + payload alleggerito (richiesta utente 2026-09-11, P0/P1).
-- Migrazione additiva preparata: NON applicata automaticamente al Supabase
-- reale.
--
-- Contesto (vedi docs/market-loading-performance-2026-09-08.md): dopo i fix
-- del 7-8 settembre list_market_watch scende a ~1.3-2s, ma con margine
-- ancora risicato rispetto al timeout di 3s sotto carico, su ~2.132
-- printing monitorate per una raccolta reale. Non si alza il timeout: si
-- riduce il lavoro vero.
--
-- Diagnosi: il costo residuo non è (solo) il calcolo dei prezzi — quello
-- resta necessario su TUTTO l'insieme candidato per poter ordinare
-- correttamente "per valore" prima di tagliare una pagina (non è evitabile,
-- non è un bug). Il costo evitabile è costruire e serializzare il JSON
-- completo (providers, mapping_evidence, price_scope...) per 2.132 righe
-- quando la UI ne mostra 60 alla volta. Le 4 funzioni sotto separano quindi
-- un passaggio "leggero" (solo printing_id + chiave di ordinamento, su
-- tutto l'insieme candidato) da un passaggio "ricco" (providers/mapping,
-- solo sulle righe della pagina corrente).
--
-- Scoping: il problema delle 2.132 righe vive nella tab Raccolta (l'intera
-- collezione). Le tab Mazzi/Watchlist/Conferma sono piccole per costruzione
-- (bounded da mazzi/watchlist manuale/coda di conferma pendente) — restano
-- a fetch singolo, ma con lo stesso alleggerimento (mapping_evidence tolto
-- ovunque tranne la coda di conferma, l'unico posto che ne ha davvero
-- bisogno).
--
-- mapping_flags/eligible_snapshots ripetono deliberatamente la stessa CTE
-- già in supabase/migrations/20260908204855_market_watch_snapshot_reuse.sql
-- (nessuna vista/funzione condivisa esiste ancora per fattorizzarle — stesso
-- stato del codice prima di questa migration, non una regressione).

-- =====================================================================
-- 1) list_market_watch_owned_page — vera paginazione, sola tab Raccolta.
-- =====================================================================
create or replace function public.list_market_watch_owned_page(
  p_token text, p_game text default 'yugioh',
  p_limit integer default 60, p_offset integer default 0,
  p_sort text default 'value', p_query text default null
) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  me text := public.session_member(p_token);
  result jsonb;
  safe_limit integer := greatest(1, least(coalesce(p_limit, 60), 200));
  safe_offset integer := greatest(0, coalesce(p_offset, 0));
  safe_query text := nullif(trim(coalesce(p_query, '')), '');
begin
  if me is null then raise exception 'Sessione scaduta'; end if;

  with owned as (
    select ci.printing_id, sum(ci.quantity_owned)::integer as quantity
    from public.collection_items ci
    join public.card_printings cp on cp.id = ci.printing_id
    where ci.owner_slug = me and cp.game = p_game
    group by ci.printing_id
  ), candidates as (
    -- Filtro di ricerca applicato QUI, prima di qualunque calcolo prezzo:
    -- riduce l'insieme candidato il prima possibile quando l'utente cerca.
    select o.printing_id, o.quantity, cp.catalog_card_id, cp.card_name, cp.set_code,
      cp.set_name, cp.rarity, cp.image_url
    from owned o
    join public.card_printings cp on cp.id = o.printing_id
    where safe_query is null
      or cp.card_name ilike '%' || safe_query || '%'
      or cp.set_code ilike '%' || safe_query || '%'
      or cp.set_name ilike '%' || safe_query || '%'
      or cp.rarity ilike '%' || safe_query || '%'
  ), mapping_flags as materialized (
    select id, public.market_mapping_is_active(provider, resolution_status, provider_metadata) active,
      (resolution_status = 'manual' or (resolution_status = 'resolved'
        and coalesce(provider_metadata->>'active', 'false') = 'true'
        and provider_metadata->>'resolverStatus' = 'EXACT')) derived
    from public.market_provider_printings
  ), eligible_snapshots as materialized (
    -- Passaggio "leggero": tocca l'intero insieme candidato (necessario per
    -- un ordinamento per valore corretto), ma solo colonne di prezzo — mai
    -- providers/mapping_evidence/price_scope qui.
    select s.printing_id, s.provider, s.price_type, s.normalized_price,
      s.normalized_currency, s.captured_at, f.active, f.derived
    from public.market_price_snapshots s
    join candidates c on c.printing_id = s.printing_id
    join mapping_flags f on f.id = s.provider_mapping_id
    where not s.is_anomalous and s.normalized_price is not null and (f.active or f.derived)
  ), preferred as (
    select distinct on (s.printing_id, s.provider) s.*
    from eligible_snapshots s where s.active and s.normalized_currency = 'EUR'
    order by s.printing_id, s.provider, public.market_reference_type(s.provider, s.price_type), s.captured_at desc
  ), reference as (
    select distinct on (printing_id) printing_id, normalized_price
    from preferred order by printing_id, public.market_reference_type(provider, price_type)
  ), history_24h as (
    select distinct on (printing_id) printing_id, normalized_price
    from eligible_snapshots where derived and captured_at <= now() - interval '24 hours'
    order by printing_id, public.market_reference_type(provider, price_type), captured_at desc
  ), scored as (
    select c.printing_id, c.card_name, c.quantity, ref.normalized_price as reference_price,
      h24.normalized_price as price_24h
    from candidates c
    left join reference ref on ref.printing_id = c.printing_id
    left join history_24h h24 on h24.printing_id = c.printing_id
  ), page as (
    -- Un solo ORDER BY con un'espressione CASE per modalità: per ogni riga
    -- solo il ramo che combacia con p_sort è non-null, gli altri finiscono
    -- in coda (nulls last) e non influenzano l'ordine — printing_id come
    -- ultimo criterio per stabilità tra pari valore (stesso principio già
    -- in list_market_watch per name/printing_id).
    select *,
      case when p_sort = 'name' then card_name end as sort_name,
      case when p_sort = 'price' then reference_price end as sort_price,
      case when p_sort = 'change' then
        case when reference_price is not null and price_24h is not null and price_24h <> 0
          then reference_price - price_24h end
      end as sort_change,
      case when p_sort not in ('name', 'price', 'change') then coalesce(reference_price, -1) * quantity end as sort_value
    from scored
    order by sort_name asc nulls last, sort_price desc nulls last, sort_change desc nulls last, sort_value desc nulls last, printing_id
    limit safe_limit offset safe_offset
  ), page_ids as (
    select printing_id from page
  ), latest_page_prices as (
    -- market_latest_prices: DISTINCT ON già pronto su TUTTA
    -- market_active_price_snapshots — economico solo se filtrato a monte,
    -- come qui (join su ~60 printing_id di pagina, non sull'intera tabella:
    -- vedi supabase-mw1-market-mapping-integrity.sql per la definizione).
    select lp.* from public.market_latest_prices lp
    join page_ids pi on pi.printing_id = lp.printing_id
  ), page_flagged as (
    select l.*, f.active from latest_page_prices l join mapping_flags f on f.id = l.provider_mapping_id
  ), page_preferred as (
    select distinct on (printing_id, provider) *
    from page_flagged where active and normalized_currency = 'EUR'
    order by printing_id, provider, public.market_reference_type(provider, price_type), captured_at desc
  ), page_lowest as (
    select distinct on (printing_id) printing_id, normalized_price
    from page_flagged where active and provider = 'cardmarket' and price_type in ('low', 'lowest') and normalized_currency = 'EUR'
    order by printing_id, captured_at desc
  ), page_history as (
    -- market_latest_prices non ha profondità storica (solo l'ultimo
    -- snapshot per tipo): 7d/30d restano su market_price_snapshots, ma ora
    -- filtrati alle sole ~60 printing_id di pagina, non più a tutto il set.
    select s.printing_id, s.price_type, s.provider, s.normalized_price, s.captured_at, f.derived
    from public.market_price_snapshots s
    join page_ids pi on pi.printing_id = s.printing_id
    join mapping_flags f on f.id = s.provider_mapping_id
    where not s.is_anomalous and s.normalized_price is not null and f.derived
  ), page_history_7d as (
    select distinct on (printing_id) printing_id, normalized_price
    from page_history where captured_at <= now() - interval '7 days'
    order by printing_id, public.market_reference_type(provider, price_type), captured_at desc
  ), page_history_30d as (
    select distinct on (printing_id) printing_id, normalized_price
    from page_history where captured_at <= now() - interval '30 days'
    order by printing_id, public.market_reference_type(provider, price_type), captured_at desc
  ), rows as (
    select c.printing_id, c.catalog_card_id, c.card_name, c.set_code, c.set_name, c.rarity, c.image_url,
      c.quantity as owned_quantity,
      coalesce(jsonb_object_agg(pp.provider, jsonb_build_object('price', pp.normalized_price, 'type', pp.price_type, 'currency', pp.normalized_currency, 'capturedAt', pp.captured_at, 'conditionReference', pp.condition_reference)) filter (where pp.provider is not null), '{}'::jsonb) providers,
      pg.reference_price, lo.normalized_price min_price, pg.price_24h,
      h7.normalized_price price_7d, h30.normalized_price price_30d,
      coalesce(cm.resolution_status, 'unresolved') mapping_status,
      coalesce(cm.provider_metadata->>'resolverStatus', cm.resolution_status, 'unresolved') resolver_status,
      case when cm.provider_metadata->>'resolverVersion' ~ '^[0-9]+$' then (cm.provider_metadata->>'resolverVersion')::integer end resolver_version,
      cm.provider_metadata->'priceScope' price_scope,
      cm.provider_metadata->'priceScope'->>'language' language_scope,
      cm.provider_metadata->'priceScope'->>'edition' edition_scope,
      cm.provider_metadata->'priceScope'->>'rarity' rarity_scope,
      cm.provider_metadata->'priceScope'->>'foil' foil_scope,
      cm.provider_metadata->>'reason' mapping_reason,
      cm.provider_product_id cardmarket_product_id,
      coalesce(cm.provider_metadata->>'productUrl', case when cm.provider_product_id is not null then 'https://www.cardmarket.com/en/YuGiOh/Products/Singles?idProduct='||cm.provider_product_id end) cardmarket_url
    from page pg
    join candidates c on c.printing_id = pg.printing_id
    left join page_preferred pp on pp.printing_id = pg.printing_id
    left join page_lowest lo on lo.printing_id = pg.printing_id
    left join page_history_7d h7 on h7.printing_id = pg.printing_id
    left join page_history_30d h30 on h30.printing_id = pg.printing_id
    left join public.market_provider_printings cm on cm.printing_id = pg.printing_id and cm.provider = 'cardmarket' and cm.variant_key = 'default'
    group by c.printing_id, c.catalog_card_id, c.card_name, c.set_code, c.set_name, c.rarity, c.image_url, c.quantity,
      pg.reference_price, lo.normalized_price, pg.price_24h, h7.normalized_price, h30.normalized_price,
      cm.resolution_status, cm.provider_product_id, cm.provider_metadata
  )
  -- total conta l'insieme candidato COMPLETO (post-ricerca, pre-pagina), non
  -- derivato dalla pagina corrente: resta corretto anche per un offset oltre
  -- l'ultima pagina (rows vuoto in quel caso, ma il totale resta quello vero).
  select jsonb_build_object(
    'items', coalesce(jsonb_agg(to_jsonb(rows) order by reference_price desc nulls last, card_name, printing_id), '[]'::jsonb),
    'total', (select count(*) from candidates),
    'limit', safe_limit, 'offset', safe_offset
  ) into result from rows;

  return coalesce(result, jsonb_build_object('items', '[]'::jsonb, 'total', 0, 'limit', safe_limit, 'offset', safe_offset));
end;
$$;

revoke all on function public.list_market_watch_owned_page(text,text,integer,integer,text,text) from public, anon, authenticated;
grant execute on function public.list_market_watch_owned_page(text,text,integer,integer,text,text) to anon, authenticated;

-- =====================================================================
-- 2) list_market_watch_extra — tab Mazzi + Watchlist, piccole per
--    costruzione (bounded dalle carte nei mazzi / dalla watchlist manuale),
--    nessuna paginazione necessaria. Stesso schema riga di oggi, senza
--    mapping_evidence.
-- =====================================================================
create or replace function public.list_market_watch_extra(p_token text, p_game text default 'yugioh')
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token); result jsonb;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;

  with sources as (
    select dc.printing_id, 'deck'::text source_type
      from public.deck_cards dc join public.decks d on d.id = dc.deck_id join public.card_printings cp on cp.id = dc.printing_id
      where d.owner_slug = me and cp.game = p_game and dc.printing_id is not null
    union
    select mw.printing_id, 'manual'
      from public.market_watch_items mw join public.card_printings cp on cp.id = mw.printing_id
      where mw.member_slug = me and cp.game = p_game
  ), owned_qty as (
    select ci.printing_id, sum(ci.quantity_owned)::integer quantity
    from public.collection_items ci join public.card_printings cp on cp.id = ci.printing_id
    where ci.owner_slug = me and cp.game = p_game group by ci.printing_id
  ), monitored as (
    select printing_id, array_agg(distinct source_type order by source_type) sources
    from (
      select printing_id, source_type from sources
      union all
      select printing_id, 'owned' from owned_qty where printing_id in (select printing_id from sources)
    ) all_sources
    group by printing_id
  ), mapping_flags as materialized (
    select id, public.market_mapping_is_active(provider, resolution_status, provider_metadata) active,
      (resolution_status = 'manual' or (resolution_status = 'resolved'
        and coalesce(provider_metadata->>'active', 'false') = 'true'
        and provider_metadata->>'resolverStatus' = 'EXACT')) derived
    from public.market_provider_printings
  ), eligible_snapshots as materialized (
    select s.printing_id, s.provider, s.price_type, s.normalized_price, s.normalized_currency,
      s.captured_at, s.condition_reference, f.active, f.derived
    from public.market_price_snapshots s
    join monitored m on m.printing_id = s.printing_id
    join mapping_flags f on f.id = s.provider_mapping_id
    where not s.is_anomalous and s.normalized_price is not null and (f.active or f.derived)
  ), preferred as (
    select distinct on (s.printing_id, s.provider) s.*
    from eligible_snapshots s where s.active and s.normalized_currency = 'EUR'
    order by s.printing_id, s.provider, public.market_reference_type(s.provider, s.price_type), s.captured_at desc
  ), reference as (
    select distinct on (printing_id) printing_id, normalized_price, captured_at
    from preferred order by printing_id, public.market_reference_type(provider, price_type)
  ), lowest as (
    select distinct on (s.printing_id) s.printing_id, s.normalized_price
    from eligible_snapshots s where s.active and s.provider = 'cardmarket'
      and s.price_type in ('low', 'lowest') and s.normalized_currency = 'EUR'
    order by s.printing_id, s.captured_at desc
  ), history_24h as (
    select distinct on (printing_id) printing_id, normalized_price
    from eligible_snapshots where derived and captured_at <= now() - interval '24 hours'
    order by printing_id, public.market_reference_type(provider, price_type), captured_at desc
  ), history_7d as (
    select distinct on (printing_id) printing_id, normalized_price
    from eligible_snapshots where derived and captured_at <= now() - interval '7 days'
    order by printing_id, public.market_reference_type(provider, price_type), captured_at desc
  ), history_30d as (
    select distinct on (printing_id) printing_id, normalized_price
    from eligible_snapshots where derived and captured_at <= now() - interval '30 days'
    order by printing_id, public.market_reference_type(provider, price_type), captured_at desc
  ), history as (
    select m.printing_id, h24.normalized_price price_24h, h7.normalized_price price_7d, h30.normalized_price price_30d
    from monitored m left join history_24h h24 using(printing_id)
    left join history_7d h7 using(printing_id) left join history_30d h30 using(printing_id)
  ), rows as (
    select cp.id printing_id, cp.catalog_card_id, cp.card_name, cp.set_code, cp.set_name, cp.rarity, cp.image_url,
      m.sources, coalesce(oq.quantity, 0) owned_quantity,
      coalesce(jsonb_object_agg(p.provider, jsonb_build_object('price', p.normalized_price, 'type', p.price_type, 'currency', p.normalized_currency, 'capturedAt', p.captured_at, 'conditionReference', p.condition_reference)) filter (where p.provider is not null), '{}'::jsonb) providers,
      ref.normalized_price reference_price, lo.normalized_price min_price,
      h.price_24h, h.price_7d, h.price_30d, ref.captured_at latest_at,
      coalesce(cm.resolution_status, 'unresolved') mapping_status,
      coalesce(cm.provider_metadata->>'resolverStatus', cm.resolution_status, 'unresolved') resolver_status,
      case when cm.provider_metadata->>'resolverVersion' ~ '^[0-9]+$' then (cm.provider_metadata->>'resolverVersion')::integer end resolver_version,
      cm.provider_metadata->'priceScope' price_scope,
      cm.provider_metadata->'priceScope'->>'language' language_scope,
      cm.provider_metadata->'priceScope'->>'edition' edition_scope,
      cm.provider_metadata->'priceScope'->>'rarity' rarity_scope,
      cm.provider_metadata->'priceScope'->>'foil' foil_scope,
      cm.provider_metadata->>'reason' mapping_reason,
      cm.provider_product_id cardmarket_product_id,
      coalesce(cm.provider_metadata->>'productUrl', case when cm.provider_product_id is not null then 'https://www.cardmarket.com/en/YuGiOh/Products/Singles?idProduct='||cm.provider_product_id end) cardmarket_url
    from monitored m
    join public.card_printings cp on cp.id = m.printing_id
    left join owned_qty oq on oq.printing_id = m.printing_id
    left join reference ref on ref.printing_id = cp.id
    left join preferred p on p.printing_id = cp.id
    left join history h on h.printing_id = cp.id
    left join lowest lo on lo.printing_id = cp.id
    left join public.market_provider_printings cm on cm.printing_id = cp.id and cm.provider = 'cardmarket' and cm.variant_key = 'default'
    group by cp.id, m.sources, oq.quantity, ref.normalized_price, ref.captured_at, lo.normalized_price,
      h.price_24h, h.price_7d, h.price_30d, cm.resolution_status, cm.provider_product_id, cm.provider_metadata
  )
  select jsonb_build_object(
    'items', coalesce(jsonb_agg(to_jsonb(rows) order by reference_price desc nulls last, card_name, printing_id), '[]'::jsonb),
    'deckUnresolved', coalesce((select jsonb_agg(jsonb_build_object('deckId', d.id, 'deckName', d.name, 'catalogCardId', dc.catalog_card_id, 'cardName', dc.card_name, 'section', dc.section, 'quantity', dc.quantity)) from public.deck_cards dc join public.decks d on d.id = dc.deck_id where d.owner_slug = me and d.game = p_game and dc.printing_id is null), '[]'::jsonb)
  ) into result from rows;

  return coalesce(result, jsonb_build_object('items', '[]'::jsonb, 'deckUnresolved', '[]'::jsonb));
end;
$$;

revoke all on function public.list_market_watch_extra(text,text) from public, anon, authenticated;
grant execute on function public.list_market_watch_extra(text,text) to anon, authenticated;

-- =====================================================================
-- 3) get_market_watch_summary — solo aggregati (mai righe intere): valore
--    portafoglio, conteggi code di conferma, fallback di prezzo per carta
--    logica (per buildMarketDecks lato client, che oggi deriva questo
--    fallback dall'array COMPLETO delle printing owned — con la Raccolta
--    paginata quell'array non è più tutto disponibile lato client).
-- =====================================================================
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
    select id, public.market_mapping_is_active(provider, resolution_status, provider_metadata) active,
      (resolution_status = 'manual' or (resolution_status = 'resolved'
        and coalesce(provider_metadata->>'active', 'false') = 'true'
        and provider_metadata->>'resolverStatus' = 'EXACT')) derived
    from public.market_provider_printings
  ), eligible_snapshots as materialized (
    select s.printing_id, s.provider, s.price_type, s.normalized_price, s.normalized_currency,
      s.captured_at, f.active
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
    -- Stessa soglia di freschezza (48h) e stessa tolleranza (>=90% delle
    -- copie con un prezzo fresco = "completo") di portfolioSummary() lato
    -- client (js/market-watch.js) — vedi coverage/complete sotto.
    select o.printing_id, o.quantity, r.normalized_price
    from owned o left join reference r on r.printing_id = o.printing_id
  ), catalog_floor as (
    -- Prezzo minimo per carta logica tra le printing owned, con il flag
    -- "era aggregato" — usato da buildMarketDecks() come fallback quando un
    -- mazzo referenzia una printing non posseduta esattamente. Un min()
    -- puro, mai una riga intera con providers/mapping_evidence. cm joinata
    -- direttamente su cardmarket, stesso pattern usato ovunque nelle altre
    -- funzioni di questa migration (oggi l'unico provider che può risultare
    -- "active", vedi market_mapping_is_active — CardTrader decommissionato).
    select distinct on (cp.catalog_card_id) cp.catalog_card_id, r.normalized_price as reference_price,
      (coalesce(cm.provider_metadata->>'resolverStatus', cm.resolution_status) = 'PROVIDER_AGGREGATE') as is_aggregate
    from owned o
    join public.card_printings cp on cp.id = o.printing_id
    join reference r on r.printing_id = o.printing_id
    left join public.market_provider_printings cm on cm.printing_id = o.printing_id and cm.provider = 'cardmarket' and cm.variant_key = 'default'
    where r.normalized_price is not null
    order by cp.catalog_card_id, r.normalized_price asc
  ), confirm_counts as (
    -- jsonb_array_length lancerebbe errore su un valore non-array: il CASE
    -- (a differenza di AND/OR, il cui ordine di valutazione Postgres non
    -- garantisce) forza il controllo del tipo prima della lunghezza.
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

-- =====================================================================
-- 4) list_market_confirm_queue — l'UNICO posto dove torna mapping_evidence/
--    candidates: righe (poche, per costruzione) che hanno davvero bisogno
--    di conferma manuale. Chiamata solo quando l'utente apre la tab
--    "Conferma" o preme "Conferma tutti aggregate".
-- =====================================================================
create or replace function public.list_market_confirm_queue(p_token text, p_game text default 'yugioh')
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token); result jsonb;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;

  with owned as (
    select distinct ci.printing_id
    from public.collection_items ci join public.card_printings cp on cp.id = ci.printing_id
    where ci.owner_slug = me and cp.game = p_game
  ), pending as (
    select cp.id printing_id, cp.card_name, cp.set_code, cp.set_name, cp.rarity, cp.image_url,
      cm.resolution_status mapping_status,
      coalesce(cm.provider_metadata->>'resolverStatus', cm.resolution_status) resolver_status,
      cm.provider_metadata->>'reason' mapping_reason,
      cm.provider_metadata->'evidence' mapping_evidence
    from owned o
    join public.card_printings cp on cp.id = o.printing_id
    join public.market_provider_printings cm on cm.printing_id = cp.id and cm.provider = 'cardmarket' and cm.variant_key = 'default'
    where
      (cm.resolution_status <> 'manual' and (cm.provider_metadata->>'reason' = 'provider_rarity_mismatch' or coalesce(cm.provider_metadata->>'resolverStatus', cm.resolution_status) = 'AMBIGUOUS'))
      or (coalesce(cm.provider_metadata->>'resolverStatus', cm.resolution_status) = 'PROVIDER_AGGREGATE'
        and (
          (case when jsonb_typeof(cm.provider_metadata->'evidence'->'candidates') = 'array' then jsonb_array_length(cm.provider_metadata->'evidence'->'candidates') > 0 else false end)
          or cm.provider_metadata->'evidence'->>'providerProductId' is not null
        ))
  )
  select jsonb_build_object('items', coalesce(jsonb_agg(to_jsonb(pending) order by card_name, printing_id), '[]'::jsonb)) into result from pending;

  return coalesce(result, jsonb_build_object('items', '[]'::jsonb));
end;
$$;

revoke all on function public.list_market_confirm_queue(text,text) from public, anon, authenticated;
grant execute on function public.list_market_confirm_queue(text,text) to anon, authenticated;

notify pgrst, 'reload schema';
