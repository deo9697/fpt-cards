-- F.P.T Cards — Market Variant Registry: resolver deterministico per set con
-- pattern V.n -> rarity verificato e stabile (SOLO RA01/RA02 per ora).
--
-- Non generalizza a "tutti i set RAxx": il whitelisting emerge PURAMENTE
-- dall'esistenza di righe verified=true in ygo_market_variant_set_templates
-- per un dato set_prefix — non c'è nessun `if setCode.startsWith('RA')` da
-- nessuna parte. Aggiungere un set futuro significa inserire righe verified
-- qui, mai un cambio di codice.
--
-- Priorità (invariata rispetto a prima, il resolver shadow non cambia
-- comportamento per i set NON in questa tabella):
--   1. manual verified mapping        (già esistente, intoccato)
--   2. existing verified registry     (già esistente, intoccato)
--   3. verified set template resolver (NUOVO, questa migration)
--   4. existing exact resolver logic  (già esistente, intoccato)
--   5. ambiguous/conflict/unresolved  (già esistente, intoccato)
--
-- Un mapping risolto via template è mapping_status='resolved',
-- mapping_source='verified_set_template', mapping_confidence=1 — MAI
-- verified=true: la verifica umana resta un atto distinto (confirm_ygo_
-- market_variant), invariato in questa migration.
--
-- Additiva. Non tocca market_provider_printings/market_price_snapshots/
-- market_price_events/pricing live/cron/alert.

begin;

-- 1) Tabella di configurazione — whitelist esplicita, mai un pattern.
create table if not exists public.ygo_market_variant_set_templates (
  id uuid primary key default gen_random_uuid(),
  set_prefix text not null check (char_length(trim(set_prefix)) between 1 and 20),
  variant_number integer not null check (variant_number between 1 and 20),
  rarity_canonical text not null references public.ygo_rarity_canon(code),
  verified boolean not null default false,
  verified_by text references public.team_members(slug),
  verified_at timestamptz,
  notes text check (notes is null or char_length(notes) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Un solo slot V.n per set, e una sola rarity per set: se qualcuno tenta
  -- di inserire due variant_number per la stessa rarity (o viceversa), il
  -- DB rifiuta a monte — il controllo "duplicate/ambiguous" nel resolver
  -- (market/providers.js) resta comunque come rete di sicurezza a valle.
  unique (set_prefix, variant_number),
  unique (set_prefix, rarity_canonical)
);

create index if not exists ygo_market_variant_set_templates_prefix_idx
  on public.ygo_market_variant_set_templates(set_prefix) where verified;

alter table public.ygo_market_variant_set_templates enable row level security;
revoke all on public.ygo_market_variant_set_templates from public, anon, authenticated;

create or replace function public.touch_ygo_market_variant_set_templates_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin new.updated_at := now(); return new; end;
$$;
drop trigger if exists touch_ygo_market_variant_set_templates_updated_at on public.ygo_market_variant_set_templates;
create trigger touch_ygo_market_variant_set_templates_updated_at before update on public.ygo_market_variant_set_templates
for each row execute function public.touch_ygo_market_variant_set_templates_updated_at();

-- Seed SOLO RA01/RA02 — verificato manualmente sui candidate_product_ids
-- osservati (RA01-EN061: 741693..741699; RA02-EN024: pattern identico).
-- verified_by/verified_at lasciati NULL: nessuna sessione admin reale ha
-- eseguito questa verifica come azione tracciata, è un bootstrap da dati già
-- discussi — se vuoi attribuirtelo, fai un UPDATE con il tuo slug dopo aver
-- applicato la migration. NON tocca RA03/RA04/RA05 (RA05 già noto instabile).
insert into public.ygo_market_variant_set_templates (set_prefix, variant_number, rarity_canonical, verified, notes) values
  ('RA01', 1, 'SUPER_RARE', true, 'Verificato su RA01-EN061: candidate_product_ids[0]=741693'),
  ('RA01', 2, 'ULTRA_RARE', true, 'Verificato su RA01-EN061: candidate_product_ids[1]=741694'),
  ('RA01', 3, 'SECRET_RARE', true, 'Verificato su RA01-EN061: candidate_product_ids[2]=741695'),
  ('RA01', 4, 'PLATINUM_SECRET_RARE', true, 'Verificato su RA01-EN061: candidate_product_ids[3]=741696'),
  ('RA01', 5, 'QUARTER_CENTURY_SECRET_RARE', true, 'Verificato su RA01-EN061: candidate_product_ids[4]=741697'),
  ('RA01', 6, 'COLLECTORS_RARE', true, 'Verificato su RA01-EN061: candidate_product_ids[5]=741698'),
  ('RA01', 7, 'ULTIMATE_RARE', true, 'Verificato su RA01-EN061: candidate_product_ids[6]=741699'),
  ('RA02', 1, 'SUPER_RARE', true, 'Stesso pattern verificato su RA02-EN024 (Garura)'),
  ('RA02', 2, 'ULTRA_RARE', true, 'Stesso pattern verificato su RA02-EN024 (Garura)'),
  ('RA02', 3, 'SECRET_RARE', true, 'Stesso pattern verificato su RA02-EN024 (Garura)'),
  ('RA02', 4, 'PLATINUM_SECRET_RARE', true, 'Stesso pattern verificato su RA02-EN024 (Garura)'),
  ('RA02', 5, 'QUARTER_CENTURY_SECRET_RARE', true, 'Stesso pattern verificato su RA02-EN024 (Garura)'),
  ('RA02', 6, 'COLLECTORS_RARE', true, 'Stesso pattern verificato su RA02-EN024 (Garura)'),
  ('RA02', 7, 'ULTIMATE_RARE', true, 'Stesso pattern verificato su RA02-EN024 (Garura)')
on conflict (set_prefix, variant_number) do nothing;

-- 2) Lettura admin dei template — piccola tabella, il client (per il badge
--    "AUTO MATCH AVAILABLE") la carica una volta e ci gira sopra la STESSA
--    funzione pura resolveYgoMarketVariantBySetTemplate() usata server-side
--    (market/providers.js), mai una logica duplicata lato client.
create or replace function public.list_ygo_market_variant_set_templates(p_token text)
returns table(set_prefix text, variant_number integer, rarity_canonical text, verified boolean, notes text)
language plpgsql stable security definer set search_path = public, extensions as $$
declare
  me text := public.session_member(p_token);
  admin boolean;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  select role = 'admin' into admin from public.team_members where slug = me;
  if not coalesce(admin, false) then raise exception 'Operazione riservata agli admin'; end if;

  return query
    select t.set_prefix, t.variant_number, t.rarity_canonical, t.verified, t.notes
    from public.ygo_market_variant_set_templates t
    order by t.set_prefix, t.variant_number;
end;
$$;
revoke all on function public.list_ygo_market_variant_set_templates(text) from public, anon, authenticated;
grant execute on function public.list_ygo_market_variant_set_templates(text) to authenticated, anon;

-- 3) Dry-run — SOLO dati locali (candidate_product_ids sono già in
--    ygo_market_variants, nessuna chiamata Cardmarket). Restituisce le righe
--    'ambiguous' grezze; la classificazione vera (resolveYgoMarketVariantBySetTemplate)
--    gira offline in scripts/market-variant-set-template-dry-run.mjs, non
--    qui — questa RPC è solo l'estrazione dati, non duplica l'algoritmo in SQL.
create or replace function public.list_ygo_market_variant_ambiguous_for_dry_run(p_token text, p_set_prefixes text[] default null)
returns table(printing_id uuid, card_name text, set_code text, rarity text, rarity_canonical text, candidate_product_ids jsonb, mapping_status text)
language plpgsql stable security definer set search_path = public, extensions as $$
declare
  me text := public.session_member(p_token);
  admin boolean;
  prefixes text[] := p_set_prefixes;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  select role = 'admin' into admin from public.team_members where slug = me;
  if not coalesce(admin, false) then raise exception 'Operazione riservata agli admin'; end if;

  return query
    select v.printing_id, cp.card_name, cp.set_code, cp.rarity, v.rarity_canonical, v.candidate_product_ids, v.mapping_status
    from public.ygo_market_variants v
    join public.card_printings cp on cp.id = v.printing_id and cp.game = 'yugioh'
    where v.mapping_status = 'ambiguous'
      and (prefixes is null or split_part(cp.set_code, '-', 1) = any(prefixes))
    order by cp.set_code, cp.rarity;
end;
$$;
revoke all on function public.list_ygo_market_variant_ambiguous_for_dry_run(text, text[]) from public, anon, authenticated;
grant execute on function public.list_ygo_market_variant_ambiguous_for_dry_run(text, text[]) to authenticated, anon;

-- 4) Safe apply — accetta SOLO coppie (printing_id, cardmarket_product_id)
--    già calcolate offline dal dry-run script; non ricalcola/fida della
--    provenienza, RI-VALIDA da zero le stesse garanzie di
--    confirm_ygo_market_variant: il product_id deve essere tra i candidati
--    CORRENTI di quella riga, e la riga deve essere ancora ambiguous, non
--    verified, non mapping_source='manual'. Se una qualunque di queste
--    condizioni non regge più (es. un admin ha nel frattempo confermato
--    manualmente quella riga), quella coppia viene saltata, mai forzata.
create or replace function public.apply_ygo_verified_set_template_resolutions(p_token text, p_resolutions jsonb)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  me text := public.session_member(p_token);
  admin boolean;
  resolution_count integer := coalesce(jsonb_array_length(p_resolutions), 0);
  applied_count integer := 0;
  skipped_count integer := 0;
  applied_ids uuid[] := '{}';
  skipped jsonb := '[]'::jsonb;
  item jsonb;
  target_printing_id uuid;
  target_product_id text;
  existing public.ygo_market_variants;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  select role = 'admin' into admin from public.team_members where slug = me;
  if not coalesce(admin, false) then raise exception 'Operazione riservata agli admin'; end if;

  if resolution_count = 0 then raise exception 'p_resolutions non può essere vuoto'; end if;
  if resolution_count > 200 then raise exception 'Massimo 200 risoluzioni per chiamata (ricevute %)', resolution_count; end if;

  for item in select * from jsonb_array_elements(p_resolutions) loop
    -- Ogni iterazione in un proprio blocco: un item malformato viene solo
    -- saltato (skipped), non fa abortire l'intero batch.
    begin
      target_printing_id := nullif(item->>'printing_id', '')::uuid;
      target_product_id := trim(coalesce(item->>'cardmarket_product_id', ''));

      if target_printing_id is null or target_product_id = '' then
        skipped_count := skipped_count + 1;
        skipped := skipped || jsonb_build_object('printing_id', item->>'printing_id', 'reason', 'invalid_input');
        continue;
      end if;

      select * into existing from public.ygo_market_variants where printing_id = target_printing_id for update;
      if not found
        or existing.verified
        or existing.mapping_source = 'manual'
        or existing.mapping_status <> 'ambiguous'
        or not exists (
          select 1 from jsonb_array_elements_text(coalesce(existing.candidate_product_ids, '[]'::jsonb)) as cid
          where cid = target_product_id
        )
      then
        skipped_count := skipped_count + 1;
        skipped := skipped || jsonb_build_object('printing_id', target_printing_id, 'reason', 'no_longer_eligible');
        continue;
      end if;

      update public.ygo_market_variants set
        cardmarket_product_id = target_product_id,
        mapping_status = 'resolved',
        mapping_source = 'verified_set_template',
        mapping_confidence = 1,
        resolution_reason = 'verified_set_variant_template'
        -- verified resta invariato (default false per queste righe, mai
        -- promosso qui) — candidate_product_ids resta intatto per audit.
      where printing_id = target_printing_id;

      applied_count := applied_count + 1;
      applied_ids := applied_ids || target_printing_id;
    exception when others then
      skipped_count := skipped_count + 1;
      skipped := skipped || jsonb_build_object('printing_id', item->>'printing_id', 'reason', 'error: ' || sqlerrm);
    end;
  end loop;

  return jsonb_build_object('applied_count', applied_count, 'skipped_count', skipped_count, 'applied_printing_ids', to_jsonb(applied_ids), 'skipped', skipped);
end;
$$;
revoke all on function public.apply_ygo_verified_set_template_resolutions(text, jsonb) from public, anon, authenticated;
grant execute on function public.apply_ygo_verified_set_template_resolutions(text, jsonb) to authenticated, anon;

-- 5) Review queue — aggiunge SOLO rarity_canonical alla proiezione esistente
--    (stessi parametri, stessa CTE usage, stesso filtro/ordinamento): serve
--    al client per calcolare il badge "AUTO MATCH AVAILABLE" con la stessa
--    funzione pura del server, senza indovinare la rarity canonica lato UI.
--    Stessa firma della funzione precedente ma RETURNS TABLE diverso (nuova
--    colonna rarity_canonical): create or replace da solo non basta quando
--    cambia l'elenco colonne del return, va droppata prima.
drop function if exists public.list_ygo_market_variant_review_queue(
  text, integer, integer, text[], text, text, boolean
);

create or replace function public.list_ygo_market_variant_review_queue(
  p_token text,
  p_limit integer default 50,
  p_offset integer default 0,
  p_statuses text[] default array['ambiguous', 'conflict', 'unresolved'],
  p_set_prefix text default null,
  p_query text default null,
  p_used_only boolean default true
) returns table(
  printing_id uuid, card_name text, set_code text, set_name text, rarity text, rarity_canonical text,
  mapping_status text, mapping_source text, mapping_confidence numeric,
  cardmarket_product_id text, cardmarket_expansion_id text, candidate_product_ids jsonb,
  resolution_reason text, verified boolean, verified_by text, verified_at timestamptz,
  collection_usage integer, deck_usage integer, loan_usage integer, usage_count integer,
  total_count bigint
) language plpgsql stable security definer set search_path = public, extensions as $$
declare
  me text := public.session_member(p_token);
  admin boolean;
  prefix text := upper(trim(coalesce(p_set_prefix, '')));
  query_text text := trim(coalesce(p_query, ''));
  statuses text[] := coalesce(p_statuses, array['ambiguous', 'conflict', 'unresolved']);
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  select role = 'admin' into admin from public.team_members where slug = me;
  if not coalesce(admin, false) then raise exception 'Operazione riservata agli admin'; end if;
  if p_limit not between 1 and 200 then raise exception 'Limite non valido'; end if;

  return query
    with usage as (
      select v.printing_id,
        count(distinct ci.id)::integer as collection_usage,
        count(distinct dc.id)::integer as deck_usage,
        count(distinct l.id)::integer as loan_usage
      from public.ygo_market_variants v
      left join public.collection_items ci on ci.printing_id = v.printing_id
      left join public.deck_cards dc on dc.printing_id = v.printing_id
      left join public.loans l on l.collection_item_id = ci.id
      group by v.printing_id
    ),
    queue as (
      select
        v.printing_id, cp.card_name, cp.set_code, cp.set_name, cp.rarity, v.rarity_canonical,
        v.mapping_status, v.mapping_source, v.mapping_confidence,
        v.cardmarket_product_id, v.cardmarket_expansion_id, v.candidate_product_ids,
        v.resolution_reason, v.verified, v.verified_by, v.verified_at,
        coalesce(u.collection_usage, 0) as collection_usage,
        coalesce(u.deck_usage, 0) as deck_usage,
        coalesce(u.loan_usage, 0) as loan_usage,
        coalesce(u.collection_usage, 0) + coalesce(u.deck_usage, 0) + coalesce(u.loan_usage, 0) as usage_count
      from public.ygo_market_variants v
      join public.card_printings cp on cp.id = v.printing_id and cp.game = 'yugioh'
      left join usage u on u.printing_id = v.printing_id
      where not v.verified
        and v.mapping_status = any(statuses)
        and (prefix = '' or cp.set_code ilike prefix || '%')
        and (query_text = '' or cp.card_name ilike '%' || query_text || '%' or cp.set_code ilike '%' || query_text || '%')
        and (not p_used_only or (coalesce(u.collection_usage, 0) + coalesce(u.deck_usage, 0) + coalesce(u.loan_usage, 0)) > 0)
    )
    select q.*, count(*) over()::bigint as total_count
    from queue q
    order by q.usage_count desc, q.set_code asc, q.rarity asc
    limit p_limit offset p_offset;
end;
$$;
revoke all on function public.list_ygo_market_variant_review_queue(text, integer, integer, text[], text, text, boolean) from public, anon, authenticated;
grant execute on function public.list_ygo_market_variant_review_queue(text, integer, integer, text[], text, text, boolean) to authenticated, anon;

-- 6) Coverage report — distingue verified_manual / resolved_set_template /
--    resolved_other, per misurare quanta copertura recupera RA01/RA02.
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
      'verified_manual', (select count(*) from with_shadow where verified and mapping_source = 'manual'),
      'resolved_set_template', (select count(*) from with_shadow where mapping_source = 'verified_set_template'),
      'resolved_other', (select count(*) from with_shadow where mapping_status = 'resolved' and coalesce(mapping_source, '') not in ('manual', 'verified_set_template')),
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
