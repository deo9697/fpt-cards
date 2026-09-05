-- F.P.T Cards — segnali Cardmarket per "Carte in evidenza".
-- Additiva: non modifica snapshot o dati esistenti.
--
-- Usa market_active_price_snapshots (manuale + EXACT + PROVIDER_AGGREGATE),
-- non market_derived_price_snapshots (manuale + EXACT soltanto): quest'ultima
-- richiede un mapping verificato per singola printing, che oggi hanno solo le
-- carte confermate manualmente ("Conferma questa" nel dettaglio) — su un
-- resolver che per Cardmarket restituisce quasi sempre PROVIDER_AGGREGATE,
-- questo lasciava "Carte in evidenza" sempre vuota. Qui è solo una vetrina
-- (non un valore definitivo), quindi il prezzo aggregato è accettabile: lo
-- stesso criterio usato per il resto della lista Market Watch.

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
    from market_active_price_snapshots s join owned o on o.printing_id=s.printing_id
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

revoke all on function public.list_market_dashboard_movers(text,text) from public,anon,authenticated;
grant execute on function public.list_market_dashboard_movers(text,text) to anon,authenticated;
notify pgrst, 'reload schema';
