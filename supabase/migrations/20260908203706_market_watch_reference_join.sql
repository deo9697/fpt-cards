-- Avoid two full preferred-price scans for every monitored printing.
-- Preserve session authorization, snapshot eligibility and the response contract.
CREATE OR REPLACE FUNCTION public.list_market_watch(p_token text, p_game text DEFAULT 'yugioh'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare me text:=public.session_member(p_token); result jsonb;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  with sources as (
    select ci.printing_id,'owned'::text source_type,sum(ci.quantity_owned)::integer quantity
      from collection_items ci join card_printings cp on cp.id=ci.printing_id
      where ci.owner_slug=me and cp.game=p_game group by ci.printing_id
    union all
    select dc.printing_id,'deck',sum(dc.quantity)::integer
      from deck_cards dc join decks d on d.id=dc.deck_id join card_printings cp on cp.id=dc.printing_id
      where d.owner_slug=me and cp.game=p_game and dc.printing_id is not null group by dc.printing_id
    union all
    select mw.printing_id,'manual',0 from market_watch_items mw join card_printings cp on cp.id=mw.printing_id
      where mw.member_slug=me and cp.game=p_game
  ), monitored as (
    select printing_id,array_agg(distinct source_type order by source_type) sources,
      max(quantity) filter(where source_type='owned') owned_quantity from sources group by printing_id
  ), preferred as (
    -- Filtra su "monitored" PRIMA del DISTINCT ON (join diretto su
    -- market_active_price_snapshots, non sulla vista già distinct-on'd
    -- market_latest_prices): garantisce che Postgres scansioni solo gli
    -- snapshot delle printing monitorate da questo utente via l'indice
    -- market_snapshots_latest_idx(printing_id,provider,price_type,captured_at),
    -- invece di dover calcolare il "più recente per tipo" su tutta la tabella.
    select distinct on (s.printing_id,s.provider) s.*
    from market_active_price_snapshots s join monitored m on m.printing_id=s.printing_id
    where s.normalized_currency='EUR' and s.normalized_price is not null
    order by s.printing_id,s.provider,market_reference_type(s.provider,s.price_type),s.captured_at desc
  ), reference as (
    select distinct on (printing_id) printing_id,normalized_price,captured_at
    from preferred order by printing_id,market_reference_type(provider,price_type)
  ), lowest as (
    select distinct on (s.printing_id) s.printing_id,s.normalized_price
    from market_active_price_snapshots s join monitored m on m.printing_id=s.printing_id
    where s.provider='cardmarket' and s.price_type in ('low','lowest')
      and s.normalized_currency='EUR' and s.normalized_price is not null
    order by s.printing_id,s.captured_at desc
  ), history as (
    select m.printing_id,
      (select s.normalized_price from market_derived_price_snapshots s where s.printing_id=m.printing_id and s.normalized_price is not null and s.captured_at<=now()-interval '24 hours' order by market_reference_type(s.provider,s.price_type),s.captured_at desc limit 1) price_24h,
      (select s.normalized_price from market_derived_price_snapshots s where s.printing_id=m.printing_id and s.normalized_price is not null and s.captured_at<=now()-interval '7 days' order by market_reference_type(s.provider,s.price_type),s.captured_at desc limit 1) price_7d,
      (select s.normalized_price from market_derived_price_snapshots s where s.printing_id=m.printing_id and s.normalized_price is not null and s.captured_at<=now()-interval '30 days' order by market_reference_type(s.provider,s.price_type),s.captured_at desc limit 1) price_30d
    from monitored m
  ), rows as (
    select cp.id printing_id,cp.catalog_card_id,cp.card_name,cp.set_code,cp.set_name,cp.rarity,cp.image_url,
      m.sources,coalesce(m.owned_quantity,0) owned_quantity,
      coalesce(jsonb_object_agg(p.provider,jsonb_build_object('price',p.normalized_price,'type',p.price_type,'currency',p.normalized_currency,'capturedAt',p.captured_at,'conditionReference',p.condition_reference)) filter(where p.provider is not null),'{}'::jsonb) providers,
      ref.normalized_price reference_price,
      lo.normalized_price min_price,
      h.price_24h,h.price_7d,h.price_30d,
      ref.captured_at latest_at,
      coalesce(cm.resolution_status,'unresolved') mapping_status,
      coalesce(cm.provider_metadata->>'resolverStatus',cm.resolution_status,'unresolved') resolver_status,
      case when cm.provider_metadata->>'resolverVersion' ~ '^[0-9]+$' then (cm.provider_metadata->>'resolverVersion')::integer end resolver_version,
      cm.provider_metadata->'priceScope' price_scope,
      cm.provider_metadata->'priceScope'->>'language' language_scope,
      cm.provider_metadata->'priceScope'->>'edition' edition_scope,
      cm.provider_metadata->'priceScope'->>'rarity' rarity_scope,
      cm.provider_metadata->'priceScope'->>'foil' foil_scope,
      cm.provider_metadata->>'reason' mapping_reason,
      cm.provider_metadata->'evidence' mapping_evidence,
      cm.provider_product_id cardmarket_product_id,
      coalesce(cm.provider_metadata->>'productUrl',case when cm.provider_product_id is not null then 'https://www.cardmarket.com/en/YuGiOh/Products/Singles?idProduct='||cm.provider_product_id end) cardmarket_url
    from monitored m join card_printings cp on cp.id=m.printing_id
    left join reference ref on ref.printing_id=cp.id
    left join preferred p on p.printing_id=cp.id left join history h on h.printing_id=cp.id
    left join lowest lo on lo.printing_id=cp.id
    left join market_provider_printings cm on cm.printing_id=cp.id and cm.provider='cardmarket' and cm.variant_key='default'
    group by cp.id,m.sources,m.owned_quantity,ref.normalized_price,ref.captured_at,lo.normalized_price,h.price_24h,h.price_7d,h.price_30d,cm.resolution_status,cm.provider_product_id,cm.provider_metadata
  )
  select jsonb_build_object(
    'items',coalesce(jsonb_agg(to_jsonb(rows) order by reference_price desc nulls last,card_name),'[]'::jsonb),
    'deckUnresolved',coalesce((select jsonb_agg(jsonb_build_object('deckId',d.id,'deckName',d.name,'catalogCardId',dc.catalog_card_id,'cardName',dc.card_name,'section',dc.section,'quantity',dc.quantity)) from deck_cards dc join decks d on d.id=dc.deck_id where d.owner_slug=me and d.game=p_game and dc.printing_id is null),'[]'::jsonb),
    'lastSync',coalesce((select max(finished_at) from market_provider_sync_runs where status in ('succeeded','partial')),null)
  ) into result from rows;
  return coalesce(result,jsonb_build_object('items','[]'::jsonb,'deckUnresolved','[]'::jsonb,'lastSync',null));
end;
$function$
;
NOTIFY pgrst, 'reload schema';
