-- F.P.T Cards — Market Watch: CUTOVER dei reader al current-price layer
-- (market_current_price_snapshots, creato e validato in
-- 20260914200000_market_current_price_layer.sql — GIÀ applicata e
-- backfillata live, shadow validation 2568/2578 equal, 10 both_missing,
-- 0 different, 0 missingCurrent/missingLegacy).
--
-- ROOT CAUSE del timeout ancora presente dopo il current layer: i tre
-- reader (get_market_watch_summary, list_market_watch_owned_page,
-- list_market_watch_extra) continuavano a derivare il prezzo CORRENTE da
-- market_price_snapshots (storico completo, ~150k righe), non dal nuovo
-- layer — il current layer esisteva ma nessuno lo leggeva ancora. Per
-- list_market_watch_owned_page in particolare, i sort 'price'/'value'/
-- 'change' hanno bisogno del reference price sull'INTERO insieme owned
-- PRIMA del taglio a pagina (non è evitabile, serve per sapere quale
-- pagina è quella giusta) — quindi lo statement timeout scattava prima
-- ancora di arrivare alle 60 righe di pagina.
--
-- QUESTA migration cambia SOLO la fonte del prezzo CORRENTE:
--   PRIMA: market_price_snapshots (storico) -> DISTINCT ON (..., captured_at desc) -> preferred/reference
--   DOPO:  market_current_price_snapshots (già un solo record per
--          provider_mapping_id+price_type, aggiornato incrementalmente dai
--          trigger di 20260914200000) -> preferred/reference
-- La struttura preferred/reference/precedenza (market_reference_type),
-- EUR-only, mapping_flags/market_mapping_is_active() resta IDENTICA: solo
-- la fonte delle righe cambia, mai la logica di scelta. Lo storico
-- (price_24h/7d/30d) resta SEMPRE su market_price_snapshots, con lo stesso
-- scope di prima (whole-set solo per 'change', page/monitored-scoped per
-- tutto il resto) — il current layer contiene solo il presente, non uno
-- storico, quindi non può e non deve sostituirlo lì.
--
-- Equivalenza dimostrata: il current layer garantisce per costruzione (vedi
-- trigger in 20260914200000) che, per ogni (provider_mapping_id,
-- price_type), la riga memorizzata è ESATTAMENTE "l'ultimo snapshot non
-- anomalo" — la stessa identica riga che preferred/reference avrebbero
-- selezionato da market_price_snapshots con "not is_anomalous ... order by
-- captured_at desc" per quella chiave. Confermato live (audit fornito):
-- confronto diretto winner current vs ultimo snapshot valido, 17.186/17.186
-- corretti; shadow report reale, 0 different, 0 missingCurrent/missingLegacy.
--
-- NON tocca: supabase/functions/market-sync/index.ts, cron, il trigger di
-- anomalia, i trigger del current layer, ygo_market_variants/Exact Price
-- Shadow/Fast Scan, il frontend (contract JSON identico), market_price_
-- snapshots (schema o dati). Nessun backfill, nessuna modifica dati.
--
-- INDICI: nessuno aggiunto. Ogni JOIN nuovo verso market_current_price_
-- snapshots avviene per printing_id, già coperto da
-- market_current_price_snapshots_printing_idx (creato in 20260914200000);
-- ogni accesso rimasto a market_price_snapshots (storico 24h/7d/30d) è
-- IDENTICO nello scope/filtro di prima di questa migration, già coperto
-- dagli indici esistenti (market_snapshots_latest_idx/history_idx). Non
-- essendoci accesso a EXPLAIN da questa sessione per giustificarne uno
-- nuovo, nessuno viene aggiunto speculativamente.

begin;

-- =====================================================================
-- 1) get_market_watch_summary — CUTOVER
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
    select id, public.market_mapping_is_active(provider, resolution_status, provider_metadata) active
    from public.market_provider_printings
    where printing_id in (select printing_id from owned)
  ), eligible_current as materialized (
    -- CUTOVER: dal current layer (già un solo record per provider_mapping_id
    -- + price_type, l'ultimo non anomalo) invece che dallo storico completo
    -- di market_price_snapshots — is_anomalous non va più filtrato qui: il
    -- trigger del current layer non promuove mai una riga anomala.
    select c.printing_id, c.provider, c.price_type, c.normalized_price, c.normalized_currency, c.captured_at
    from public.market_current_price_snapshots c
    join owned o on o.printing_id = c.printing_id
    join mapping_flags f on f.id = c.provider_mapping_id
    where f.active and c.normalized_price is not null
  ), preferred as (
    select distinct on (s.printing_id, s.provider) s.*
    from eligible_current s where s.normalized_currency = 'EUR'
    order by s.printing_id, s.provider, public.market_reference_type(s.provider, s.price_type), s.captured_at desc
  ), reference as (
    select distinct on (printing_id) printing_id, normalized_price
    from preferred order by printing_id, public.market_reference_type(provider, price_type)
  ), portfolio as (
    select o.printing_id, o.quantity, r.normalized_price
    from owned o left join reference r on r.printing_id = o.printing_id
  ), catalog_floor as (
    select distinct on (cp.catalog_card_id) cp.catalog_card_id, r.normalized_price as reference_price,
      (coalesce(cm.provider_metadata->>'resolverStatus', cm.resolution_status) = 'PROVIDER_AGGREGATE') as is_aggregate
    from owned o
    join public.card_printings cp on cp.id = o.printing_id
    join reference r on r.printing_id = o.printing_id
    left join public.market_provider_printings cm on cm.printing_id = o.printing_id and cm.provider = 'cardmarket' and cm.variant_key = 'default'
    where r.normalized_price is not null
    order by cp.catalog_card_id, r.normalized_price asc
  ), confirm_counts as (
    -- Invariato: già indipendente dalla pipeline prezzi.
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
-- 2) list_market_watch_owned_page — CUTOVER
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
  page_id_array uuid[] := '{}';
  total_count integer := 0;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;

  -- FASE A — determina SOLO le printing_id (e il totale) di questa pagina.
  -- Invariato rispetto a 20260914090000: percorsi distinti per p_sort. Il
  -- CUTOVER qui è la fonte del reference price whole-set: dal current
  -- layer, mai più da market_price_snapshots.
  if p_sort = 'name' then
    -- Invariato: nessun prezzo calcolato prima del LIMIT.
    with owned as (
      select ci.printing_id, sum(ci.quantity_owned)::integer as quantity
      from public.collection_items ci
      join public.card_printings cp on cp.id = ci.printing_id
      where ci.owner_slug = me and cp.game = p_game
      group by ci.printing_id
    ), candidates as (
      select o.printing_id, o.quantity, cp.catalog_card_id, cp.card_name, cp.set_code,
        cp.set_name, cp.rarity, cp.image_url
      from owned o
      join public.card_printings cp on cp.id = o.printing_id
      where safe_query is null
        or cp.card_name ilike '%' || safe_query || '%'
        or cp.set_code ilike '%' || safe_query || '%'
        or cp.set_name ilike '%' || safe_query || '%'
        or cp.rarity ilike '%' || safe_query || '%'
    ), paged as (
      select printing_id, count(*) over()::integer as page_total
      from candidates
      order by card_name asc nulls last, printing_id
      limit safe_limit offset safe_offset
    )
    select coalesce(array_agg(printing_id), '{}'), coalesce(max(page_total), 0)
      into page_id_array, total_count
    from paged;

  elsif p_sort = 'change' then
    -- Il reference price whole-set ora viene dal current layer (CUTOVER).
    -- Il 24h whole-set resta INVARIATO su market_price_snapshots (storico
    -- reale, serve comunque prima del LIMIT per ordinare per variazione —
    -- non eliminabile senza cambiare la correttezza della paginazione).
    with owned as (
      select ci.printing_id, sum(ci.quantity_owned)::integer as quantity
      from public.collection_items ci
      join public.card_printings cp on cp.id = ci.printing_id
      where ci.owner_slug = me and cp.game = p_game
      group by ci.printing_id
    ), candidates as (
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
      where printing_id in (select printing_id from candidates)
    ), eligible_current as materialized (
      -- CUTOVER: reference price whole-set dal current layer.
      select c.printing_id, c.provider, c.price_type, c.normalized_price, c.normalized_currency, c.captured_at
      from public.market_current_price_snapshots c
      join candidates cd on cd.printing_id = c.printing_id
      join mapping_flags f on f.id = c.provider_mapping_id
      where f.active and c.normalized_price is not null
    ), preferred as (
      select distinct on (s.printing_id, s.provider) s.*
      from eligible_current s where s.normalized_currency = 'EUR'
      order by s.printing_id, s.provider, public.market_reference_type(s.provider, s.price_type), s.captured_at desc
    ), reference as (
      select distinct on (printing_id) printing_id, normalized_price
      from preferred order by printing_id, public.market_reference_type(provider, price_type)
    ), eligible_derived as materialized (
      -- INVARIATO: il 24h whole-set resta sullo storico reale (il current
      -- layer contiene solo il presente, non può fornire "24 ore fa").
      select s.printing_id, s.provider, s.price_type, s.normalized_price, s.captured_at
      from public.market_price_snapshots s
      join candidates c on c.printing_id = s.printing_id
      join mapping_flags f on f.id = s.provider_mapping_id
      where not s.is_anomalous and s.normalized_price is not null and f.derived
    ), history_24h as (
      select distinct on (printing_id) printing_id, normalized_price
      from eligible_derived where captured_at <= now() - interval '24 hours'
      order by printing_id, public.market_reference_type(provider, price_type), captured_at desc
    ), scored as (
      select c.printing_id, ref.normalized_price as reference_price, h24.normalized_price as price_24h
      from candidates c
      left join reference ref on ref.printing_id = c.printing_id
      left join history_24h h24 on h24.printing_id = c.printing_id
    ), paged as (
      select printing_id, count(*) over()::integer as page_total
      from scored
      order by
        case when reference_price is not null and price_24h is not null and price_24h <> 0
          then reference_price - price_24h end desc nulls last,
        printing_id
      limit safe_limit offset safe_offset
    )
    select coalesce(array_agg(printing_id), '{}'), coalesce(max(page_total), 0)
      into page_id_array, total_count
    from paged;

  else
    -- 'price'/'value' (+ fallback): il reference price whole-set ora viene
    -- SOLO dal current layer (CUTOVER) — nessuno storico coinvolto qui.
    with owned as (
      select ci.printing_id, sum(ci.quantity_owned)::integer as quantity
      from public.collection_items ci
      join public.card_printings cp on cp.id = ci.printing_id
      where ci.owner_slug = me and cp.game = p_game
      group by ci.printing_id
    ), candidates as (
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
      select id, public.market_mapping_is_active(provider, resolution_status, provider_metadata) active
      from public.market_provider_printings
      where printing_id in (select printing_id from candidates)
    ), eligible_current as materialized (
      select c.printing_id, c.provider, c.price_type, c.normalized_price, c.captured_at
      from public.market_current_price_snapshots c
      join candidates cd on cd.printing_id = c.printing_id
      join mapping_flags f on f.id = c.provider_mapping_id
      where f.active and c.normalized_currency = 'EUR' and c.normalized_price is not null
    ), preferred as (
      select distinct on (s.printing_id, s.provider) s.*
      from eligible_current s
      order by s.printing_id, s.provider, public.market_reference_type(s.provider, s.price_type), s.captured_at desc
    ), reference as (
      select distinct on (printing_id) printing_id, normalized_price
      from preferred order by printing_id, public.market_reference_type(provider, price_type)
    ), scored as (
      select c.printing_id, c.quantity, ref.normalized_price as reference_price
      from candidates c left join reference ref on ref.printing_id = c.printing_id
    ), paged as (
      select printing_id, count(*) over()::integer as page_total
      from scored
      order by
        case when p_sort = 'price' then reference_price end desc nulls last,
        case when p_sort <> 'price' then coalesce(reference_price, -1) * quantity end desc nulls last,
        printing_id
      limit safe_limit offset safe_offset
    )
    select coalesce(array_agg(printing_id), '{}'), coalesce(max(page_total), 0)
      into page_id_array, total_count
    from paged;
  end if;

  -- FASE B — identica per qualunque p_sort, SOLO sulle printing_id di
  -- questa pagina. CUTOVER: providers/reference_price/min_price ora
  -- derivano TUTTI da un'unica lettura del current layer (page_current),
  -- non più da market_latest_prices (vista NON materializzata) né da
  -- market_price_snapshots. page_history/24h/7d/30d restano INVARIATI su
  -- market_price_snapshots (il current layer contiene solo il presente).
  with page_ids as (
    select unnest(page_id_array) as printing_id
  ), candidates as (
    select pi.printing_id, coalesce(cq.quantity, 0) as quantity, cp.catalog_card_id, cp.card_name,
      cp.set_code, cp.set_name, cp.rarity, cp.image_url
    from page_ids pi
    join public.card_printings cp on cp.id = pi.printing_id
    left join (
      select printing_id, sum(quantity_owned)::integer as quantity
      from public.collection_items where owner_slug = me group by printing_id
    ) cq on cq.printing_id = pi.printing_id
  ), mapping_flags as materialized (
    select id, public.market_mapping_is_active(provider, resolution_status, provider_metadata) active,
      (resolution_status = 'manual' or (resolution_status = 'resolved'
        and coalesce(provider_metadata->>'active', 'false') = 'true'
        and provider_metadata->>'resolverStatus' = 'EXACT')) derived
    from public.market_provider_printings
    where printing_id in (select printing_id from page_ids)
  ), page_current as (
    -- CUTOVER: unica fonte per providers/reference_price/min_price.
    select c.printing_id, c.provider, c.price_type, c.normalized_price, c.normalized_currency,
      c.captured_at, c.condition_reference
    from public.market_current_price_snapshots c
    join page_ids pi on pi.printing_id = c.printing_id
    join mapping_flags f on f.id = c.provider_mapping_id
    where f.active
  ), page_preferred as (
    select distinct on (printing_id, provider) *
    from page_current where normalized_currency = 'EUR'
    order by printing_id, provider, public.market_reference_type(provider, price_type), captured_at desc
  ), page_lowest as (
    select distinct on (printing_id) printing_id, normalized_price
    from page_current where provider = 'cardmarket' and price_type in ('low', 'lowest') and normalized_currency = 'EUR'
    order by printing_id, captured_at desc
  ), page_reference as (
    select distinct on (printing_id) printing_id, normalized_price
    from page_preferred order by printing_id, public.market_reference_type(provider, price_type)
  ), page_history as (
    -- INVARIATO rispetto a prima di questa migration: stesso filtro
    -- f.derived, stessa fonte (market_price_snapshots), stesso scope
    -- (page_ids) — il current layer non ha alcuna profondità storica.
    select s.printing_id, s.price_type, s.provider, s.normalized_price, s.captured_at, f.derived
    from public.market_price_snapshots s
    join page_ids pi on pi.printing_id = s.printing_id
    join mapping_flags f on f.id = s.provider_mapping_id
    where not s.is_anomalous and s.normalized_price is not null and f.derived
  ), page_history_24h as (
    select distinct on (printing_id) printing_id, normalized_price
    from page_history where captured_at <= now() - interval '24 hours'
    order by printing_id, public.market_reference_type(provider, price_type), captured_at desc
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
      pr.normalized_price reference_price, lo.normalized_price min_price, h24.normalized_price price_24h,
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
    from candidates c
    left join page_preferred pp on pp.printing_id = c.printing_id
    left join page_lowest lo on lo.printing_id = c.printing_id
    left join page_reference pr on pr.printing_id = c.printing_id
    left join page_history_24h h24 on h24.printing_id = c.printing_id
    left join page_history_7d h7 on h7.printing_id = c.printing_id
    left join page_history_30d h30 on h30.printing_id = c.printing_id
    left join public.market_provider_printings cm on cm.printing_id = c.printing_id and cm.provider = 'cardmarket' and cm.variant_key = 'default'
    group by c.printing_id, c.catalog_card_id, c.card_name, c.set_code, c.set_name, c.rarity, c.image_url, c.quantity,
      pr.normalized_price, lo.normalized_price, h24.normalized_price, h7.normalized_price, h30.normalized_price,
      cm.resolution_status, cm.provider_product_id, cm.provider_metadata
  )
  select jsonb_build_object(
    'items', coalesce(jsonb_agg(to_jsonb(rows) order by reference_price desc nulls last, card_name, printing_id), '[]'::jsonb),
    'total', total_count, 'limit', safe_limit, 'offset', safe_offset
  ) into result from rows;

  return coalesce(result, jsonb_build_object('items', '[]'::jsonb, 'total', total_count, 'limit', safe_limit, 'offset', safe_offset));
end;
$$;

revoke all on function public.list_market_watch_owned_page(text,text,integer,integer,text,text) from public, anon, authenticated;
grant execute on function public.list_market_watch_owned_page(text,text,integer,integer,text,text) to anon, authenticated;

-- =====================================================================
-- 3) list_market_watch_extra — CUTOVER
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
    -- Ristretto a monitored (stessa restrizione già applicata a summary/
    -- owned_page): mapping_flags non era mai joinata fuori da monitored,
    -- restringerla non cambia alcun risultato.
    select id, public.market_mapping_is_active(provider, resolution_status, provider_metadata) active,
      (resolution_status = 'manual' or (resolution_status = 'resolved'
        and coalesce(provider_metadata->>'active', 'false') = 'true'
        and provider_metadata->>'resolverStatus' = 'EXACT')) derived
    from public.market_provider_printings
    where printing_id in (select printing_id from monitored)
  ), eligible_current as materialized (
    -- CUTOVER: reference/lowest/providers dal current layer, non più da
    -- market_price_snapshots (storico completo).
    select c.printing_id, c.provider, c.price_type, c.normalized_price, c.normalized_currency,
      c.captured_at, c.condition_reference
    from public.market_current_price_snapshots c
    join monitored m on m.printing_id = c.printing_id
    join mapping_flags f on f.id = c.provider_mapping_id
    where f.active
  ), preferred as (
    select distinct on (s.printing_id, s.provider) s.*
    from eligible_current s where s.normalized_currency = 'EUR'
    order by s.printing_id, s.provider, public.market_reference_type(s.provider, s.price_type), s.captured_at desc
  ), reference as (
    select distinct on (printing_id) printing_id, normalized_price, captured_at
    from preferred order by printing_id, public.market_reference_type(provider, price_type)
  ), lowest as (
    select distinct on (s.printing_id) s.printing_id, s.normalized_price
    from eligible_current s where s.provider = 'cardmarket'
      and s.price_type in ('low', 'lowest') and s.normalized_currency = 'EUR'
    order by s.printing_id, s.captured_at desc
  ), eligible_derived as materialized (
    -- INVARIATO: 24h/7d/30d restano dallo storico reale, solo sulle
    -- printing monitorate (stesso scope di sempre).
    select s.printing_id, s.provider, s.price_type, s.normalized_price, s.captured_at
    from public.market_price_snapshots s
    join monitored m on m.printing_id = s.printing_id
    join mapping_flags f on f.id = s.provider_mapping_id
    where not s.is_anomalous and s.normalized_price is not null and f.derived
  ), history_24h as (
    select distinct on (printing_id) printing_id, normalized_price
    from eligible_derived where captured_at <= now() - interval '24 hours'
    order by printing_id, public.market_reference_type(provider, price_type), captured_at desc
  ), history_7d as (
    select distinct on (printing_id) printing_id, normalized_price
    from eligible_derived where captured_at <= now() - interval '7 days'
    order by printing_id, public.market_reference_type(provider, price_type), captured_at desc
  ), history_30d as (
    select distinct on (printing_id) printing_id, normalized_price
    from eligible_derived where captured_at <= now() - interval '30 days'
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

commit;
