-- F.P.T Cards — Market Watch: prezzo minimo ("a partire da") Cardmarket.
-- Migration additiva: applicare dopo supabase-milestone-5-1-market-watch-operational.sql.
-- Aggiunge min_price al payload di list_market_watch, letto dallo snapshot
-- Cardmarket price_type 'low'/'lowest' più recente (il "a partire da" del
-- Price Guide, distinto dal prezzo di riferimento che resta 'trend').
-- Non modifica/elimina snapshot esistenti, nessun nuovo scheduler.

create or replace function public.list_market_watch(p_token text,p_game text default 'yugioh')
returns jsonb language plpgsql security definer set search_path=public,extensions as $$
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
    select distinct on (lp.printing_id,lp.provider) lp.*
    from market_latest_prices lp join monitored m on m.printing_id=lp.printing_id
    where lp.normalized_currency='EUR' and lp.normalized_price is not null
    order by lp.printing_id,lp.provider,market_reference_type(lp.provider,lp.price_type),lp.captured_at desc
  ), lowest as (
    select distinct on (lp.printing_id) lp.printing_id,lp.normalized_price
    from market_latest_prices lp join monitored m on m.printing_id=lp.printing_id
    where lp.provider='cardmarket' and lp.price_type in ('low','lowest')
      and lp.normalized_currency='EUR' and lp.normalized_price is not null
    order by lp.printing_id,lp.captured_at desc
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
      (select p2.normalized_price from preferred p2 where p2.printing_id=cp.id order by market_reference_type(p2.provider,p2.price_type) limit 1) reference_price,
      lo.normalized_price min_price,
      h.price_24h,h.price_7d,h.price_30d,
      (select p3.captured_at from preferred p3 where p3.printing_id=cp.id order by market_reference_type(p3.provider,p3.price_type) limit 1) latest_at,
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
    left join preferred p on p.printing_id=cp.id left join history h on h.printing_id=cp.id
    left join lowest lo on lo.printing_id=cp.id
    left join market_provider_printings cm on cm.printing_id=cp.id and cm.provider='cardmarket' and cm.variant_key='default'
    group by cp.id,m.sources,m.owned_quantity,lo.normalized_price,h.price_24h,h.price_7d,h.price_30d,cm.resolution_status,cm.provider_product_id,cm.provider_metadata
  )
  select jsonb_build_object(
    'items',coalesce(jsonb_agg(to_jsonb(rows) order by reference_price desc nulls last,card_name),'[]'::jsonb),
    'deckUnresolved',coalesce((select jsonb_agg(jsonb_build_object('deckId',d.id,'deckName',d.name,'catalogCardId',dc.catalog_card_id,'cardName',dc.card_name,'section',dc.section,'quantity',dc.quantity)) from deck_cards dc join decks d on d.id=dc.deck_id where d.owner_slug=me and d.game=p_game and dc.printing_id is null),'[]'::jsonb),
    'lastSync',coalesce((select max(finished_at) from market_provider_sync_runs where status in ('succeeded','partial')),null)
  ) into result from rows;
  return coalesce(result,jsonb_build_object('items','[]'::jsonb,'deckUnresolved','[]'::jsonb,'lastSync',null));
end;
$$;

grant execute on function public.list_market_watch(text,text) to anon,authenticated;
