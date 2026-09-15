-- Independent endpoint: old app versions keep their upward-only response.
create or replace function public.list_market_dashboard_trends(p_token text,p_game text default 'yugioh')
returns jsonb language plpgsql security definer set search_path=public,extensions as $$
declare me text:=public.session_member(p_token); result jsonb;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  with owned as (
    select ci.printing_id,sum(ci.quantity_owned)::integer quantity
    from collection_items ci join card_printings cp on cp.id=ci.printing_id
    where ci.owner_slug=me and cp.game=p_game and ci.quantity_owned>0
    group by ci.printing_id
  ), prices as (
    select o.*,t.normalized_price current_price,b.normalized_price baseline_price,t.captured_at
    from owned o
    cross join lateral (
      select s.normalized_price,s.captured_at from market_active_price_snapshots s
      where s.printing_id=o.printing_id and s.provider='cardmarket' and s.price_type='trend'
        and s.normalized_currency='EUR' and s.normalized_price>0 and s.is_anomalous is not true
        and s.captured_at>=now()-interval '48 hours'
      order by s.captured_at desc,s.id desc limit 1
    ) t
    cross join lateral (
      select s.normalized_price from market_active_price_snapshots s
      where s.printing_id=o.printing_id and s.provider='cardmarket' and s.price_type='avg7'
        and s.normalized_currency='EUR' and s.normalized_price>0 and s.is_anomalous is not true
        and s.captured_at>=now()-interval '48 hours'
      order by s.captured_at desc,s.id desc limit 1
    ) b
  ), candidates as (
    select cp.catalog_card_id,cp.card_name,cp.set_code,cp.rarity,cp.image_url,p.*,
      (p.current_price-p.baseline_price)/p.baseline_price*100 change
    from prices p join card_printings cp on cp.id=p.printing_id
    where p.current_price<>p.baseline_price
  ), unique_cards as (
    select *,row_number() over(partition by coalesce(catalog_card_id::text,card_name)
      order by abs(change) desc,printing_id) card_rank from candidates
  ), ranked as (
    select *,row_number() over(partition by (change>0) order by abs(change) desc,printing_id) direction_rank
    from unique_cards where card_rank=1
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'printingId',printing_id,'catalogCardId',catalog_card_id,'cardName',card_name,
    'setCode',set_code,'rarity',rarity,'imageUrl',image_url,'ownedQuantity',quantity,
    'referencePrice',current_price,'baselinePrice',baseline_price,'positiveChange',change,
    'capturedAt',captured_at
  ) order by change desc),'[]'::jsonb) into result from ranked where direction_rank<=3;
  return result;
end;
$$;
revoke all on function public.list_market_dashboard_trends(text,text) from public;
grant execute on function public.list_market_dashboard_trends(text,text) to anon,authenticated;
notify pgrst, 'reload schema';
