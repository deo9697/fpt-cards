-- Rollback MW1 Market Watch mapping integrity.
-- Ripristina il contratto SQL pre-MW1 senza cancellare mapping, snapshot, eventi o sync run.

begin;

create or replace view public.market_latest_prices
with (security_invoker=true) as
select distinct on (s.printing_id,s.provider,s.price_type)
  s.id,s.printing_id,s.provider_mapping_id,s.provider,s.price_type,
  s.original_currency,s.original_price,s.normalized_currency,s.normalized_price,
  s.language,s.condition_reference,s.foil,s.available_quantity,s.sample_size,
  s.source_updated_at,s.captured_at,s.metadata
from public.market_price_snapshots s
order by s.printing_id,s.provider,s.price_type,s.captured_at desc,s.id desc;

revoke all on public.market_latest_prices from public,anon,authenticated;

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
  ), history as (
    select m.printing_id,
      (select s.normalized_price from market_price_snapshots s where s.printing_id=m.printing_id and s.normalized_price is not null and s.captured_at<=now()-interval '24 hours' order by market_reference_type(s.provider,s.price_type),s.captured_at desc limit 1) price_24h,
      (select s.normalized_price from market_price_snapshots s where s.printing_id=m.printing_id and s.normalized_price is not null and s.captured_at<=now()-interval '7 days' order by market_reference_type(s.provider,s.price_type),s.captured_at desc limit 1) price_7d,
      (select s.normalized_price from market_price_snapshots s where s.printing_id=m.printing_id and s.normalized_price is not null and s.captured_at<=now()-interval '30 days' order by market_reference_type(s.provider,s.price_type),s.captured_at desc limit 1) price_30d
    from monitored m
  ), rows as (
    select cp.id printing_id,cp.catalog_card_id,cp.card_name,cp.set_code,cp.set_name,cp.rarity,cp.image_url,
      m.sources,coalesce(m.owned_quantity,0) owned_quantity,
      coalesce(jsonb_object_agg(p.provider,jsonb_build_object('price',p.normalized_price,'type',p.price_type,'currency',p.normalized_currency,'capturedAt',p.captured_at,'conditionReference',p.condition_reference)) filter(where p.provider is not null),'{}'::jsonb) providers,
      (select p2.normalized_price from preferred p2 where p2.printing_id=cp.id order by market_reference_type(p2.provider,p2.price_type) limit 1) reference_price,
      h.price_24h,h.price_7d,h.price_30d,
      (select p3.captured_at from preferred p3 where p3.printing_id=cp.id order by market_reference_type(p3.provider,p3.price_type) limit 1) latest_at,
      coalesce(cm.resolution_status,'unresolved') mapping_status,cm.provider_product_id cardmarket_product_id,
      coalesce(cm.provider_metadata->>'productUrl',case when cm.provider_product_id is not null then 'https://www.cardmarket.com/en/YuGiOh/Products/Singles?idProduct='||cm.provider_product_id end) cardmarket_url
    from monitored m join card_printings cp on cp.id=m.printing_id
    left join preferred p on p.printing_id=cp.id left join history h on h.printing_id=cp.id
    left join market_provider_printings cm on cm.printing_id=cp.id and cm.provider='cardmarket' and cm.variant_key='default'
    group by cp.id,m.sources,m.owned_quantity,h.price_24h,h.price_7d,h.price_30d,cm.resolution_status,cm.provider_product_id,cm.provider_metadata
  )
  select jsonb_build_object(
    'items',coalesce(jsonb_agg(to_jsonb(rows) order by reference_price desc nulls last,card_name),'[]'::jsonb),
    'deckUnresolved',coalesce((select jsonb_agg(jsonb_build_object('deckId',d.id,'deckName',d.name,'catalogCardId',dc.catalog_card_id,'cardName',dc.card_name,'section',dc.section,'quantity',dc.quantity)) from deck_cards dc join decks d on d.id=dc.deck_id where d.owner_slug=me and d.game=p_game and dc.printing_id is null),'[]'::jsonb),
    'lastSync',coalesce((select max(finished_at) from market_provider_sync_runs where status in ('succeeded','partial')),null)
  ) into result from rows;
  return coalesce(result,jsonb_build_object('items','[]'::jsonb,'deckUnresolved','[]'::jsonb,'lastSync',null));
end;
$$;

create or replace function public.list_market_price_history(p_token text,p_printing_id uuid,p_days integer default 30)
returns table(provider text,price_type text,price numeric,captured_at timestamptz)
language plpgsql security definer set search_path=public,extensions as $$
declare me text:=public.session_member(p_token);
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  if p_days not between 1 and 365 then raise exception 'Intervallo storico non valido'; end if;
  if not exists(
    select 1 from collection_items ci where ci.owner_slug=me and ci.printing_id=p_printing_id
    union all select 1 from deck_cards dc join decks d on d.id=dc.deck_id where d.owner_slug=me and dc.printing_id=p_printing_id
    union all select 1 from market_watch_items mw where mw.member_slug=me and mw.printing_id=p_printing_id
  ) then raise exception 'Printing non monitorata'; end if;
  return query select distinct on (s.provider,s.price_type,(s.captured_at at time zone 'UTC')::date)
    s.provider,s.price_type,s.normalized_price,s.captured_at
  from market_price_snapshots s where s.printing_id=p_printing_id and s.normalized_currency='EUR'
    and s.normalized_price is not null and s.captured_at>=now()-make_interval(days=>p_days)
    and ((s.provider='cardmarket' and s.price_type='trend') or (s.provider='cardtrader' and s.price_type='reference'))
  order by s.provider,s.price_type,(s.captured_at at time zone 'UTC')::date,s.captured_at desc;
end;
$$;

create or replace function public.list_market_dashboard_movers(p_token text,p_game text default 'yugioh')
returns jsonb language plpgsql security definer set search_path=public,extensions as $$
declare me text:=public.session_member(p_token); result jsonb;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  with owned as (
    select ci.printing_id,sum(ci.quantity_owned)::integer quantity
    from collection_items ci join card_printings cp on cp.id=ci.printing_id
    where ci.owner_slug=me and cp.game=p_game and ci.quantity_owned>0
    group by ci.printing_id
  ), latest as (
    select distinct on (s.printing_id,s.price_type) s.printing_id,s.price_type,s.normalized_price,s.captured_at
    from market_price_snapshots s join owned o on o.printing_id=s.printing_id
    where s.provider='cardmarket' and s.normalized_currency='EUR' and s.normalized_price is not null
      and s.price_type in ('trend','avg1','avg7','avg30') and s.captured_at>=now()-interval '48 hours'
    order by s.printing_id,s.price_type,s.captured_at desc,s.id desc
  ), prices as (
    select printing_id,
      max(normalized_price) filter(where price_type='trend') trend,
      max(normalized_price) filter(where price_type='avg1') avg1,
      max(normalized_price) filter(where price_type='avg7') avg7,
      max(normalized_price) filter(where price_type='avg30') avg30,
      max(captured_at) captured_at
    from latest group by printing_id
  ), ranked as (
    select cp.id printing_id,cp.catalog_card_id,cp.card_name,cp.set_code,cp.set_name,cp.rarity,cp.image_url,o.quantity,
      p.trend reference_price,coalesce(p.avg7,p.avg30,p.avg1) baseline_price,
      ((p.trend-coalesce(p.avg7,p.avg30,p.avg1))/nullif(coalesce(p.avg7,p.avg30,p.avg1),0))*100 positive_change,
      p.avg30,p.avg7,p.avg1,p.captured_at
    from prices p join owned o on o.printing_id=p.printing_id join card_printings cp on cp.id=p.printing_id
    where p.trend>coalesce(p.avg7,p.avg30,p.avg1) and coalesce(p.avg7,p.avg30,p.avg1)>0
    order by positive_change desc,(p.trend-coalesce(p.avg7,p.avg30,p.avg1)) desc
    limit 3
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'printingId',printing_id,'catalogCardId',catalog_card_id,'cardName',card_name,'setCode',set_code,'setName',set_name,
    'rarity',rarity,'imageUrl',image_url,'ownedQuantity',quantity,'referencePrice',reference_price,
    'baselinePrice',baseline_price,'positiveChange',positive_change,'capturedAt',captured_at,
    'sparkline',jsonb_build_array(
      jsonb_build_object('label','AVG30','price',avg30,'order',1),jsonb_build_object('label','AVG7','price',avg7,'order',2),
      jsonb_build_object('label','AVG1','price',avg1,'order',3),jsonb_build_object('label','TREND','price',reference_price,'order',4)
    )) order by positive_change desc),'[]'::jsonb) into result from ranked;
  return result;
end;
$$;

revoke all on function public.list_market_price_history(text,uuid,integer),public.list_market_watch(text,text),public.list_market_dashboard_movers(text,text) from public,anon,authenticated;
grant execute on function public.list_market_price_history(text,uuid,integer),public.list_market_watch(text,text),public.list_market_dashboard_movers(text,text) to anon,authenticated;

drop view if exists public.market_derived_price_snapshots;
drop view if exists public.market_active_price_snapshots;
drop function if exists public.market_mapping_is_active(text,text,jsonb);

notify pgrst, 'reload schema';
commit;
