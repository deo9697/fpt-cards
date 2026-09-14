-- F.P.T Cards — Market Variant Registry: discovery RPC per il backfill
-- mirato delle printing RA01/RA02 realmente in uso.
--
-- Sola lettura. Trova le printing Yu-Gi-Oh! che:
--   - hanno set_prefix tra quelli con ALMENO un template verified=true in
--     ygo_market_variant_set_templates (oggi RA01/RA02, in futuro solo set
--     aggiunti esplicitamente lì — MAI un pattern tipo startsWith('RA'));
--   - sono realmente usate (collection_items/deck_cards/loans/
--     market_watch_items, count distinct per evitare duplicati da JOIN);
--   - non hanno ancora una riga utile in ygo_market_variants (nessuna riga,
--     oppure ancora ambiguous/unresolved/conflict) — 'resolved'/'verified'
--     sono già a posto e non compaiono qui.
--
-- Nessuna scrittura: additiva, non tocca pricing/Market Watch/Printing
-- Registry/candidate metadata/Edge Function.

begin;

create or replace function public.list_ygo_market_variant_backfill_candidates(
  p_token text,
  p_set_prefixes text[] default array['RA01', 'RA02'],
  p_used_only boolean default true,
  p_limit integer default 100
) returns table(
  printing_id uuid, card_name text, set_code text, rarity text, rarity_canonical text,
  collection_usage integer, deck_usage integer, loan_usage integer, market_watch_usage integer, usage_count integer,
  registry_exists boolean, mapping_status text, mapping_source text,
  cardmarket_product_id text, candidate_product_ids jsonb
) language plpgsql stable security definer set search_path = public, extensions as $$
declare
  me text := public.session_member(p_token);
  admin boolean;
  whitelisted_prefixes text[];
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  select role = 'admin' into admin from public.team_members where slug = me;
  if not coalesce(admin, false) then raise exception 'Operazione riservata agli admin'; end if;
  if p_limit not between 1 and 500 then raise exception 'Limite non valido'; end if;

  -- La whitelist emerge PURAMENTE dai dati (verified=true), mai da un
  -- pattern sul prefisso. p_set_prefixes, se passato, può solo RESTRINGERE
  -- questa whitelist, mai estenderla: non c'è modo di far comparire un set
  -- non ancora verificato passando un prefisso arbitrario.
  select array_agg(distinct t.set_prefix) into whitelisted_prefixes
  from public.ygo_market_variant_set_templates t
  where t.verified and (p_set_prefixes is null or t.set_prefix = any(p_set_prefixes));

  if whitelisted_prefixes is null or array_length(whitelisted_prefixes, 1) is null then
    return; -- nessun set whitelisted per questi prefissi -> nessun candidato, mai un errore
  end if;

  return query
    with usage as (
      -- CTE separate per ciascuna sorgente + count(distinct ...): un JOIN
      -- diretto tra le 4 tabelle moltiplicherebbe le righe (una collection
      -- item * un deck_card per la stessa printing = conteggio falsato).
      select cp.id as printing_id,
        count(distinct ci.id)::integer as collection_usage,
        count(distinct dc.id)::integer as deck_usage,
        count(distinct l.id)::integer as loan_usage,
        count(distinct mw.id)::integer as market_watch_usage
      from public.card_printings cp
      left join public.collection_items ci on ci.printing_id = cp.id
      left join public.deck_cards dc on dc.printing_id = cp.id
      left join public.loans l on l.collection_item_id = ci.id
      left join public.market_watch_items mw on mw.printing_id = cp.id
      where cp.game = 'yugioh' and split_part(cp.set_code, '-', 1) = any(whitelisted_prefixes)
      group by cp.id
    ),
    used as (
      select u.*, (u.collection_usage + u.deck_usage + u.loan_usage + u.market_watch_usage) as usage_count
      from usage u
      where not p_used_only or (u.collection_usage + u.deck_usage + u.loan_usage + u.market_watch_usage) > 0
    )
    select cp.id, cp.card_name, cp.set_code, cp.rarity, v.rarity_canonical,
      u.collection_usage, u.deck_usage, u.loan_usage, u.market_watch_usage, u.usage_count,
      (v.printing_id is not null) as registry_exists,
      v.mapping_status, v.mapping_source, v.cardmarket_product_id, v.candidate_product_ids
    from used u
    join public.card_printings cp on cp.id = u.printing_id
    left join public.ygo_market_variants v on v.printing_id = cp.id
    where v.printing_id is null or v.mapping_status in ('ambiguous', 'unresolved', 'conflict')
    order by u.usage_count desc, cp.set_code asc, cp.rarity asc
    limit p_limit;
end;
$$;
revoke all on function public.list_ygo_market_variant_backfill_candidates(text, text[], boolean, integer) from public, anon, authenticated;
grant execute on function public.list_ygo_market_variant_backfill_candidates(text, text[], boolean, integer) to authenticated, anon;

commit;
