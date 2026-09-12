-- F.P.T Cards — Market Variant Registry: fase finale dello shadow pricing.
--
-- Confronta, SENZA toccare il pricing live, due valori per ogni printing
-- exact-eligible:
--   legacy_price = quello che Market Watch mostra oggi (stessa identica
--     logica di list_market_watch_owned_page: market_active_price_snapshots
--     + market_reference_type(), che per un mapping PROVIDER_AGGREGATE è già
--     un Math.min tra più candidate_product_ids — vedi
--     CardmarketPriceGuideProvider.getCurrentPrice() in market/providers.js)
--   exact_price  = il prezzo del SOLO cardmarket_product_id verificato/
--     risolto in ygo_market_variants, MAI un minimo tra candidati
--     (exactPriceForProduct() in market/providers.js, additiva, non tocca
--     getCurrentPrice())
--
-- Additiva, sola lettura + una tabella nuova di sola diagnostica. Non tocca
-- market_provider_printings/market_price_snapshots/market_price_events/
-- market_watch_items/collection_items/decks/loans. Il pricing live resta
-- quello di sempre finché non si deciderà un cutover esplicito (fuori scope
-- qui).

begin;

-- 1) Shadow comparison table — un solo snapshot corrente per printing (non
--    uno storico: la stessa riga viene sovrascritta a ogni run, coerente con
--    "preferire semplicità" — se in futuro servirà uno storico si aggiungerà
--    un campo id/captured_at come chiave, non prima che serva davvero).
create table if not exists public.ygo_market_variant_price_shadow (
  printing_id uuid primary key references public.card_printings(id) on delete cascade,
  cardmarket_product_id text not null check (char_length(cardmarket_product_id) between 1 and 100),
  legacy_price numeric,
  exact_price numeric,
  price_type text,
  absolute_delta numeric,
  percentage_delta numeric,
  comparison_status text not null check (comparison_status in ('same', 'close', 'different', 'exact_missing', 'legacy_missing')),
  mapping_status text,
  mapping_source text,
  verified boolean not null default false,
  captured_at timestamptz not null default now()
);

create index if not exists ygo_market_variant_price_shadow_status_idx
  on public.ygo_market_variant_price_shadow(comparison_status);

alter table public.ygo_market_variant_price_shadow enable row level security;
revoke all on public.ygo_market_variant_price_shadow from public, anon, authenticated;

-- 2) Prezzo di riferimento "legacy" per una lista di printing — mirror di
--    sola lettura della stessa identica selezione (market_active_price_snapshots
--    + market_reference_type, normalized_currency='EUR', not is_anomalous)
--    già usata da list_market_watch_owned_page/get_market_watch_summary.
--    NON modifica né duplica quelle RPC, le legge e basta. Mai esposta a
--    anon/authenticated: solo il service role (l'Edge Function market-sync)
--    la chiama, mai il browser.
create or replace function public.ygo_market_variant_legacy_reference_prices(p_printing_ids uuid[])
returns table(printing_id uuid, price_type text, provider text, normalized_price numeric, captured_at timestamptz)
language sql stable set search_path = public as $$
  select distinct on (s.printing_id) s.printing_id, s.price_type, s.provider, s.normalized_price, s.captured_at
  from public.market_active_price_snapshots s
  where s.printing_id = any(p_printing_ids)
    and s.normalized_currency = 'EUR'
    and not s.is_anomalous
  order by s.printing_id, public.market_reference_type(s.provider, s.price_type), s.captured_at desc
$$;
revoke all on function public.ygo_market_variant_legacy_reference_prices(uuid[]) from public, anon, authenticated;

-- 3) Avvia una run di shadow price comparison — stesso identico meccanismo
--    del canary (ygo_market_variant_canary_runs è già una coda generica
--    "run diagnostica admin, risultato in jsonb", riusata qui senza
--    duplicare tabella/RPC di lettura: get_ygo_market_variant_canary_run
--    funziona invariato anche per queste run).
create or replace function public.run_ygo_market_variant_price_shadow(p_token text, p_printing_ids uuid[])
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  me text := public.session_member(p_token);
  admin boolean;
  ids uuid[] := coalesce(p_printing_ids, '{}'::uuid[]);
  id_count integer := coalesce(array_length(ids, 1), 0);
  invalid_count integer;
  new_run_id uuid;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  select role = 'admin' into admin from public.team_members where slug = me;
  if not coalesce(admin, false) then raise exception 'Operazione riservata agli admin'; end if;

  if id_count = 0 then raise exception 'printing_ids non può essere vuoto'; end if;
  if id_count > 20 then raise exception 'Massimo 20 printing_ids per run (ricevuti %)', id_count; end if;

  select count(*) into invalid_count
  from unnest(ids) as pid
  where not exists (select 1 from public.card_printings cp where cp.id = pid and cp.game = 'yugioh');
  if invalid_count > 0 then raise exception '% printing_id non validi o non Yu-Gi-Oh!', invalid_count; end if;

  insert into public.ygo_market_variant_canary_runs (requested_by, printing_ids)
  values (me, ids)
  returning id into new_run_id;

  perform net.http_post(
    url := 'https://gonycawupahawocqafcf.supabase.co/functions/v1/market-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-market-sync-secret',
      (select decrypted_secret from vault.decrypted_secrets where name = 'market_sync_secret')
    ),
    body := jsonb_build_object('marketVariantPriceShadowRunId', new_run_id),
    timeout_milliseconds := 60000
  );

  return jsonb_build_object('run_id', new_run_id, 'status', 'pending');
end;
$$;
revoke all on function public.run_ygo_market_variant_price_shadow(text, uuid[]) from public, anon, authenticated;
grant execute on function public.run_ygo_market_variant_price_shadow(text, uuid[]) to authenticated, anon;

-- 4) Coverage report — SOLO dati locali (nessuna chiamata Cardmarket): stato
--    del registry, eleggibilità exact, e il diff reale se/quando disponibile
--    da ygo_market_variant_price_shadow (0 finché nessuna run è ancora stata
--    eseguita — onesto, non un placeholder finto). "Used printing" = almeno
--    una tra collection_items/deck_cards/loans/market_watch_items, mai
--    l'intero catalogo Yu-Gi-Oh.
create or replace function public.ygo_market_variant_exact_price_report(p_token text, p_game text default 'yugioh')
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  me text := public.session_member(p_token);
  admin boolean;
  result jsonb;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  select role = 'admin' into admin from public.team_members where slug = me;
  if not coalesce(admin, false) then raise exception 'Operazione riservata agli admin'; end if;

  with usage as (
    select cp.id as printing_id, cp.card_name, cp.set_code, cp.rarity,
      count(distinct ci.id)::integer as collection_usage,
      count(distinct dc.id)::integer as deck_usage,
      count(distinct l.id)::integer as loan_usage,
      count(distinct mw.id)::integer as market_watch_usage
    from public.card_printings cp
    left join public.collection_items ci on ci.printing_id = cp.id
    left join public.deck_cards dc on dc.printing_id = cp.id
    left join public.loans l on l.collection_item_id = ci.id
    left join public.market_watch_items mw on mw.printing_id = cp.id
    where cp.game = p_game
    group by cp.id, cp.card_name, cp.set_code, cp.rarity
  ),
  used as (
    select *,
      (collection_usage + deck_usage + loan_usage + market_watch_usage) as usage_count
    from usage
    where collection_usage > 0 or deck_usage > 0 or loan_usage > 0 or market_watch_usage > 0
  ),
  registry as (
    select u.*, v.mapping_status, v.mapping_source, v.verified, v.cardmarket_product_id,
      (v.cardmarket_product_id is not null and (v.verified or v.mapping_status = 'resolved')) as eligible_exact
    from used u
    left join public.ygo_market_variants v on v.printing_id = u.printing_id
  ),
  with_shadow as (
    select r.*, s.legacy_price, s.exact_price, s.comparison_status
    from registry r
    left join public.ygo_market_variant_price_shadow s on s.printing_id = r.printing_id
  ),
  priority as (
    select printing_id, card_name, set_code, rarity, mapping_status, eligible_exact, usage_count,
      collection_usage, deck_usage, loan_usage, market_watch_usage
    from with_shadow
    where coalesce(mapping_status, 'unresolved') <> 'verified'
    order by
      (collection_usage > 0) desc, (deck_usage > 0) desc, (market_watch_usage > 0) desc, (loan_usage > 0) desc,
      usage_count desc,
      (mapping_status in ('ambiguous', 'conflict')) desc,
      set_code asc
    limit 50
  )
  select jsonb_build_object(
    'game', p_game,
    'generated_at', now(),
    'total_used_printings', (select count(*) from with_shadow),
    'registry', jsonb_build_object(
      'verified', (select count(*) from with_shadow where mapping_status = 'verified'),
      'resolved', (select count(*) from with_shadow where mapping_status = 'resolved'),
      'ambiguous', (select count(*) from with_shadow where mapping_status = 'ambiguous'),
      'conflict', (select count(*) from with_shadow where mapping_status = 'conflict'),
      'unresolved', (select count(*) from with_shadow where coalesce(mapping_status, 'unresolved') = 'unresolved')
    ),
    'exact_price_coverage', jsonb_build_object(
      'eligible_exact', (select count(*) from with_shadow where eligible_exact),
      'exact_price_available', (select count(*) from with_shadow where eligible_exact and exact_price is not null),
      'legacy_only', (select count(*) from with_shadow where not eligible_exact and legacy_price is not null),
      'no_price', (select count(*) from with_shadow where not eligible_exact and legacy_price is null and exact_price is null)
    ),
    'coverage_pct', jsonb_build_object(
      'all_used', (select case when count(*) = 0 then 0 else round(100.0 * count(*) filter (where eligible_exact) / count(*), 1) end from with_shadow),
      'collection', (select case when count(*) = 0 then 0 else round(100.0 * count(*) filter (where eligible_exact) / count(*), 1) end from with_shadow where collection_usage > 0),
      'decks', (select case when count(*) = 0 then 0 else round(100.0 * count(*) filter (where eligible_exact) / count(*), 1) end from with_shadow where deck_usage > 0),
      'loans', (select case when count(*) = 0 then 0 else round(100.0 * count(*) filter (where eligible_exact) / count(*), 1) end from with_shadow where loan_usage > 0),
      'market_watch', (select case when count(*) = 0 then 0 else round(100.0 * count(*) filter (where eligible_exact) / count(*), 1) end from with_shadow where market_watch_usage > 0)
    ),
    -- Popolato solo dalle printing su cui è già girata almeno una
    -- run_ygo_market_variant_price_shadow: 0 ovunque prima del primo run,
    -- non un placeholder — vedi KNOWN LIMITATIONS nel report consegnato.
    'diff', jsonb_build_object(
      'same', (select count(*) from with_shadow where comparison_status = 'same'),
      'close', (select count(*) from with_shadow where comparison_status = 'close'),
      'different', (select count(*) from with_shadow where comparison_status = 'different'),
      'legacy_missing', (select count(*) from with_shadow where comparison_status = 'legacy_missing'),
      'exact_missing', (select count(*) from with_shadow where eligible_exact and comparison_status = 'exact_missing')
    ),
    'priority_sample', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'printing_id', printing_id, 'card_name', card_name, 'set_code', set_code, 'rarity', rarity,
        'mapping_status', coalesce(mapping_status, 'unresolved'), 'eligible_exact', eligible_exact, 'usage_count', usage_count
      )), '[]'::jsonb)
      from priority
    ),
    'note', 'diff/exact_price_available riflettono solo le printing su cui è già girata run_ygo_market_variant_price_shadow (nessuna chiamata Cardmarket in questo report).'
  ) into result;

  return result;
end;
$$;
revoke all on function public.ygo_market_variant_exact_price_report(text, text) from public, anon, authenticated;
grant execute on function public.ygo_market_variant_exact_price_report(text, text) to authenticated, anon;

commit;
