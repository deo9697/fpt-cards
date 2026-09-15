-- Read-only regression check: largest collection, same 3s budget as anon.
-- Expected: at most 6 rows, query completes without statement timeout.
begin;
set local statement_timeout='3s';
with result as (
with owned as (
    select ci.printing_id,sum(ci.quantity_owned)::integer quantity
    from collection_items ci join card_printings cp on cp.id=ci.printing_id
    where (select owner_slug from public.collection_items group by owner_slug order by count(*) desc limit 1)=ci.owner_slug and cp.game='yugioh' and ci.quantity_owned>0
    group by ci.printing_id
  ), recent as materialized (
    select s.printing_id,s.price_type,s.normalized_price,s.captured_at,s.snapshot_id id
    from market_current_price_snapshots s join owned o on o.printing_id=s.printing_id
    join market_provider_printings mp on mp.id=s.provider_mapping_id
    where market_mapping_is_active(mp.provider,mp.resolution_status,mp.provider_metadata) and s.provider='cardmarket' and s.price_type in ('trend','avg7')
      and s.normalized_currency='EUR' and s.normalized_price>0
      and s.captured_at>=now()-interval '48 hours'
  ), latest as (
    select distinct on (printing_id,price_type) * from recent
    order by printing_id,price_type,captured_at desc,id desc
  ), prices as (
    select o.printing_id,o.quantity,
      max(s.normalized_price) filter(where s.price_type='trend') current_price,
      max(s.normalized_price) filter(where s.price_type='avg7') baseline_price,
      max(s.captured_at) filter(where s.price_type='trend') captured_at
    from owned o join latest s on s.printing_id=o.printing_id
    group by o.printing_id,o.quantity
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
  ) order by change desc),'[]'::jsonb) from ranked where direction_rank<=3
)
select jsonb_array_length(coalesce) as cards from result;
rollback;

