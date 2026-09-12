-- F.P.T Cards — Market Variant Registry: micro-feature admin per lanciare
-- manualmente run_ygo_market_variant_price_shadow() dal pannello Market
-- Variant Resolver invece che da console/script.
--
-- list_ygo_market_variant_review_queue() esiste già ma non basta qui: esclude
-- SEMPRE le righe verified=true (`where not v.verified`) perché la sua unica
-- ragione d'essere è la coda di REVISIONE (ambiguous/conflict/unresolved).
-- L'eligibility richiesta qui è l'esatto opposto — SOLO printing già
-- risolte o verificate:
--   cardmarket_product_id is not null AND (verified = true OR mapping_status = 'resolved')
-- la stessa identica regola di isExactPriceEligible() in market/providers.js
-- e di run_ygo_market_variant_price_shadow()/ygo_market_variant_exact_price_report()
-- — replicata qui, non reinventata.
--
-- Additiva e sola lettura: nessuna tabella nuova (il LEFT JOIN su
-- ygo_market_variant_price_shadow mostra l'ultimo confronto già calcolato,
-- se esiste, senza duplicarne lo storage), nessuna modifica alle RPC
-- esistenti, nessun cambio a pricing live/Market Watch/candidate metadata/
-- Printing Registry/Edge Function.

begin;

create or replace function public.list_ygo_market_variant_exact_price_eligible(
  p_token text,
  p_limit integer default 30,
  p_offset integer default 0,
  p_query text default null,
  p_used_only boolean default true
) returns table(
  printing_id uuid, card_name text, set_code text, set_name text, rarity text,
  mapping_status text, mapping_source text, verified boolean, cardmarket_product_id text,
  collection_usage integer, deck_usage integer, loan_usage integer, usage_count integer,
  legacy_price numeric, exact_price numeric, price_type text,
  absolute_delta numeric, percentage_delta numeric, comparison_status text, shadow_captured_at timestamptz,
  total_count bigint
) language plpgsql stable security definer set search_path = public, extensions as $$
declare
  me text := public.session_member(p_token);
  admin boolean;
  query_text text := trim(coalesce(p_query, ''));
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  select role = 'admin' into admin from public.team_members where slug = me;
  if not coalesce(admin, false) then raise exception 'Operazione riservata agli admin'; end if;
  if p_limit not between 1 and 100 then raise exception 'Limite non valido'; end if;

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
    eligible as (
      select
        v.printing_id, cp.card_name, cp.set_code, cp.set_name, cp.rarity,
        v.mapping_status, v.mapping_source, v.verified, v.cardmarket_product_id,
        coalesce(u.collection_usage, 0) as collection_usage,
        coalesce(u.deck_usage, 0) as deck_usage,
        coalesce(u.loan_usage, 0) as loan_usage,
        coalesce(u.collection_usage, 0) + coalesce(u.deck_usage, 0) + coalesce(u.loan_usage, 0) as usage_count
      from public.ygo_market_variants v
      join public.card_printings cp on cp.id = v.printing_id and cp.game = 'yugioh'
      left join usage u on u.printing_id = v.printing_id
      where v.cardmarket_product_id is not null
        and (v.verified or v.mapping_status = 'resolved')
        and (query_text = '' or cp.card_name ilike '%' || query_text || '%' or cp.set_code ilike '%' || query_text || '%')
        and (not p_used_only or (coalesce(u.collection_usage, 0) + coalesce(u.deck_usage, 0) + coalesce(u.loan_usage, 0)) > 0)
    )
    select e.*,
      s.legacy_price, s.exact_price, s.price_type, s.absolute_delta, s.percentage_delta, s.comparison_status,
      s.captured_at as shadow_captured_at,
      count(*) over()::bigint as total_count
    from eligible e
    left join public.ygo_market_variant_price_shadow s on s.printing_id = e.printing_id
    order by e.usage_count desc, e.set_code asc, e.rarity asc
    limit p_limit offset p_offset;
end;
$$;
revoke all on function public.list_ygo_market_variant_exact_price_eligible(text, integer, integer, text, boolean) from public, anon, authenticated;
grant execute on function public.list_ygo_market_variant_exact_price_eligible(text, integer, integer, text, boolean) to authenticated, anon;

commit;
