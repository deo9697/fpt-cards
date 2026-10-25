-- F.P.T Cards — Dashboard Market Watch "Vetrina" (2026-10-25).
-- Sostituisce, per la Dashboard, list_market_dashboard_movers: quella
-- ordinava per variazione PERCENTUALE senza soglie, quindi vinceva sempre la
-- carta da 0,02 € passata a 0,09 € (+400%). Qui conta l'impatto in EURO sulle
-- copie possedute, con soglie anti-rumore, e il valore della collezione è
-- confrontato A PARITÀ DI CARTE (solo quelle con un prezzo anche N giorni fa:
-- una carta appena collegata a Cardmarket non è un guadagno).
--
-- Precalcolata, non live: le letture "prezzo di 7/30 giorni fa" per ~3.000
-- carte costano 0,5–2,5 s sull'istanza piccola, troppo vicino ai 3 s del ruolo
-- anon. I prezzi cambiano una volta al giorno (job fpt-market-sync-daily alle
-- 01:00/02:00 UTC), quindi il riepilogo si calcola alle 02:30 UTC per ogni
-- membro e la RPC della Dashboard legge una riga.
--
-- "Stimato" = mapping con più prodotti Cardmarket e nessuna variante esatta
-- live (stessa regola di applyExactVariantPricing in market-sync).
-- Additiva: list_market_dashboard_movers resta per i client non aggiornati.
-- Rollback: select cron.unschedule('fpt-market-dashboard-overview-daily');
--   drop function public.get_market_dashboard_overview(text, text);
--   drop function public.refresh_market_dashboard_overviews();
--   drop function public.compute_market_dashboard_overview(text, text);
--   drop table public.market_dashboard_overviews;

create table if not exists public.market_dashboard_overviews (
  owner_slug text not null,
  game text not null,
  payload jsonb not null,
  computed_at timestamptz not null default now(),
  primary key (owner_slug, game)
);
alter table public.market_dashboard_overviews enable row level security;
revoke all on table public.market_dashboard_overviews from anon, authenticated;

create or replace function public.compute_market_dashboard_overview(p_member text, p_game text default 'yugioh')
returns jsonb
language sql
stable
security definer
set search_path to 'public', 'extensions'
as $function$
  with owned as (
    select ci.printing_id, sum(ci.quantity_owned)::integer quantity
    from public.collection_items ci join public.card_printings cp on cp.id = ci.printing_id
    where ci.owner_slug = p_member and cp.game = p_game and ci.quantity_owned > 0
    group by ci.printing_id
  ), mappings as materialized (
    select cm.id, cm.printing_id,
      public.market_mapping_is_active(cm.provider, cm.resolution_status, cm.provider_metadata) active,
      case when jsonb_typeof(cm.provider_metadata->'candidateProductIds') = 'array'
        then cm.provider_metadata->'candidateProductIds' else '[]'::jsonb end candidates
    from public.market_provider_printings cm
    where cm.provider = 'cardmarket' and cm.printing_id in (select printing_id from owned)
  ), current as materialized (
    select distinct on (c.printing_id) c.printing_id, m.candidates,
      c.normalized_price price,
      (select a.normalized_price from public.market_current_price_snapshots a
        where a.provider_mapping_id = c.provider_mapping_id and a.price_type = 'avg30') avg30
    from public.market_current_price_snapshots c
    join mappings m on m.id = c.provider_mapping_id and m.active
    where c.provider = 'cardmarket' and c.price_type = 'trend' and c.normalized_currency = 'EUR' and c.normalized_price > 0
    order by c.printing_id, c.captured_at desc
  ), priced as materialized (
    select cur.printing_id, o.quantity, cur.price, cur.avg30,
      (jsonb_array_length(cur.candidates) > 1 and not exists (
        select 1 from public.ygo_market_variants v
        where v.printing_id = cur.printing_id and v.cardmarket_product_id is not null
          and (v.verified or (v.mapping_status = 'resolved' and v.mapping_confidence >= 1))
          and cur.candidates ? v.cardmarket_product_id
      )) estimated,
      (select s.normalized_price from public.market_price_snapshots s
        where s.printing_id = cur.printing_id and s.provider = 'cardmarket' and s.price_type = 'trend'
          and s.captured_at <= now() - interval '7 days' and s.normalized_currency = 'EUR'
        order by s.captured_at desc limit 1) price7,
      (select s.normalized_price from public.market_price_snapshots s
        where s.printing_id = cur.printing_id and s.provider = 'cardmarket' and s.price_type = 'trend'
          and s.captured_at <= now() - interval '30 days' and s.normalized_currency = 'EUR'
        order by s.captured_at desc limit 1) price30
    from current cur join owned o on o.printing_id = cur.printing_id
  ), card as (
    select p.*, cp.catalog_card_id, cp.card_name, cp.set_code, cp.rarity, cp.image_url
    from priced p join public.card_printings cp on cp.id = p.printing_id
  )
  select jsonb_build_object(
    'value', coalesce((select round(sum(price * quantity), 2) from priced), 0),
    'pricedCards', (select count(*) from priced),
    'change7', (select jsonb_build_object('eur', round(sum((price - price7) * quantity), 2), 'base', round(sum(price7 * quantity), 2), 'cards', count(*))
                from priced where price7 > 0),
    'change30', (select jsonb_build_object('eur', round(sum((price - price30) * quantity), 2), 'base', round(sum(price30 * quantity), 2), 'cards', count(*))
                 from priced where price30 > 0),
    'top', coalesce((select jsonb_agg(row_to_json(t)::jsonb order by t.price desc) from (
        select printing_id "printingId", catalog_card_id "catalogCardId", card_name "cardName", set_code "setCode", rarity, image_url "imageUrl",
          quantity, price, price7, price30, estimated
        from card order by price desc, printing_id limit 5) t), '[]'::jsonb),
    'movers', coalesce((select jsonb_agg(row_to_json(t)::jsonb order by abs(t."deltaEur") desc) from (
        select printing_id "printingId", catalog_card_id "catalogCardId", card_name "cardName", set_code "setCode", rarity, image_url "imageUrl",
          quantity, price, price7, round((price - price7) * quantity, 2) "deltaEur", round((price / price7 - 1) * 100, 1) "deltaPct"
        from card
        where not estimated and price7 > 0 and price >= 1 and abs(price - price7) >= 0.5
        order by abs((price - price7) * quantity) desc, printing_id limit 4) t), '[]'::jsonb),
    'signals', jsonb_build_object(
      'aboveMonthAverage', (select count(*) from priced where not estimated and price >= 1 and avg30 > 0 and price >= avg30 * 1.2),
      'duplicatesValue', coalesce((select round(sum(price * (quantity - 1)), 2) from priced where not estimated and quantity >= 2 and price >= 3), 0),
      'duplicates', coalesce((select jsonb_agg(row_to_json(t)::jsonb order by t.spare desc) from (
          select card_name "cardName", quantity, round(price * (quantity - 1), 2) spare
          from card where not estimated and quantity >= 2 and price >= 3
          order by price * (quantity - 1) desc limit 3) t), '[]'::jsonb),
      'estimated', (select count(*) from priced where estimated)
    ),
    'lastSync', (select max(finished_at) from public.market_provider_sync_runs where status in ('succeeded', 'partial'))
  );
$function$;
revoke all on function public.compute_market_dashboard_overview(text, text) from public, anon, authenticated;

-- Tutti i membri con carte del gioco; Market Watch Cardmarket copre solo
-- Yu-Gi-Oh (market_sync_targets), quindi per ora solo 'yugioh'.
create or replace function public.refresh_market_dashboard_overviews(p_game text default 'yugioh')
returns integer
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare member text; refreshed integer := 0;
begin
  for member in
    select distinct ci.owner_slug from public.collection_items ci join public.card_printings cp on cp.id = ci.printing_id
    where cp.game = p_game and ci.quantity_owned > 0
  loop
    insert into public.market_dashboard_overviews (owner_slug, game, payload, computed_at)
    values (member, p_game, public.compute_market_dashboard_overview(member, p_game), now())
    on conflict (owner_slug, game) do update set payload = excluded.payload, computed_at = excluded.computed_at;
    refreshed := refreshed + 1;
  end loop;
  return refreshed;
end;
$function$;
revoke all on function public.refresh_market_dashboard_overviews(text) from public, anon, authenticated;

create or replace function public.get_market_dashboard_overview(p_token text, p_game text default 'yugioh')
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'extensions'
as $function$
declare me text := public.session_member(p_token); result jsonb;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  select o.payload || jsonb_build_object('computedAt', o.computed_at) into result
  from public.market_dashboard_overviews o where o.owner_slug = me and o.game = p_game;
  return result; -- null: membro nuovo, il riepilogo arriva col calcolo notturno
end;
$function$;
revoke all on function public.get_market_dashboard_overview(text, text) from public;
grant execute on function public.get_market_dashboard_overview(text, text) to anon, authenticated;

select cron.unschedule(jobid) from cron.job where jobname = 'fpt-market-dashboard-overview-daily';
select cron.schedule('fpt-market-dashboard-overview-daily', '30 2 * * *', $cron$
  select public.refresh_market_dashboard_overviews('yugioh');
$cron$);

select public.refresh_market_dashboard_overviews('yugioh');
