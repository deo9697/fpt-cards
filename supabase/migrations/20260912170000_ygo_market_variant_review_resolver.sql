-- F.P.T Cards — Market Variant Registry: pannello admin di risoluzione
-- manuale, stesso modello di ygo_artwork_admin_resolver.
--
-- Flusso:
--   ygo_market_variants (ambiguous/conflict/unresolved, non verified)
--   -> list_ygo_market_variant_review_queue()  [admin, sola lettura]
--   -> l'admin apre i candidate_product_ids su Cardmarket (lato client) e
--      sceglie quello giusto
--   -> confirm_ygo_market_variant(printing_id, product_id scelto)
--   -> mapping_status='verified', mapping_source='manual', verified=true
--   -> resolveYgoMarketVariant() (shadow) non lo tocca più: verified vince
--      sempre (shouldPersistMarketVariantShadow torna false) — già garantito
--      dal codice esistente, nessuna modifica al resolver in questa migration.
--
-- Additiva, sola lettura + un solo UPDATE mirato su ygo_market_variants.
-- Non tocca market_provider_printings/market_price_snapshots/
-- market_price_events — questa migration resta shadow-only, come tutto il
-- resto del Market Variant Registry finora.

begin;

-- 1) Review queue — ricalca list_ygo_artwork_review_queue
--    (20260912090000_ygo_artwork_curator_role.sql): stessa CTE "usage"
--    (collection_items/deck_cards/loans), qui però su printing_id diretto
--    (ygo_market_variants è già 1 riga per printing, non serve passare da
--    set_code_normalized). Esclude sempre verified=true.
create or replace function public.list_ygo_market_variant_review_queue(
  p_token text,
  p_limit integer default 50,
  p_offset integer default 0,
  p_statuses text[] default array['ambiguous', 'conflict', 'unresolved'],
  p_set_prefix text default null,
  p_query text default null,
  p_used_only boolean default true
) returns table(
  printing_id uuid, card_name text, set_code text, set_name text, rarity text,
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
        v.printing_id, cp.card_name, cp.set_code, cp.set_name, cp.rarity,
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

-- 2) Conferma manuale — accetta SOLO printing_id + il product_id scelto dal
--    candidate_product_ids già noto; ogni altro campo (rarity canonica,
--    expansion, source, verified_by, confidence, note) è derivato
--    server-side, mai passato dal client (stesso principio di
--    confirm_ygo_printing_artwork: nessun valore libero, solo una scelta tra
--    opzioni che il server già conosce).
create or replace function public.confirm_ygo_market_variant(
  p_token text, p_printing_id uuid, p_cardmarket_product_id text
) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  me text := public.session_member(p_token);
  admin boolean;
  chosen text := trim(coalesce(p_cardmarket_product_id, ''));
  existing public.ygo_market_variants;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  select role = 'admin' into admin from public.team_members where slug = me;
  if not coalesce(admin, false) then raise exception 'Operazione riservata agli admin'; end if;

  if chosen = '' then raise exception 'cardmarket_product_id non valido'; end if;
  if p_printing_id is null then raise exception 'printing_id non valido'; end if;

  select * into existing from public.ygo_market_variants where printing_id = p_printing_id for update;
  if not found then
    raise exception 'Nessuna market variant calcolata per questa printing: esegui prima il resolver (canary/sync)';
  end if;

  -- Regola fondamentale: il product_id scelto deve essere uno dei candidati
  -- che il resolver ha già trovato per QUESTA printing — mai un valore
  -- inventato o preso da un'altra printing/rarity.
  if not exists (
    select 1 from jsonb_array_elements_text(coalesce(existing.candidate_product_ids, '[]'::jsonb)) as cid
    where cid = chosen
  ) then
    raise exception 'Il product_id scelto non è tra i candidati noti per questa printing';
  end if;

  update public.ygo_market_variants set
    cardmarket_product_id = chosen,
    mapping_status = 'verified',
    mapping_source = 'manual',
    mapping_confidence = 1,
    verified = true,
    verified_at = now(),
    verified_by = me,
    resolution_reason = 'manual_candidate_verified'
    -- candidate_product_ids NON viene toccato: resta l'audit trail di cosa
    -- il resolver aveva trovato al momento della conferma.
  where printing_id = p_printing_id;

  return jsonb_build_object(
    'printingId', p_printing_id, 'cardmarketProductId', chosen,
    'mappingStatus', 'verified', 'mappingSource', 'manual', 'verified', true,
    'verifiedBy', me, 'verifiedAt', now()
  );
end;
$$;

revoke all on function public.list_ygo_market_variant_review_queue(text, integer, integer, text[], text, text, boolean) from public, anon, authenticated;
grant execute on function public.list_ygo_market_variant_review_queue(text, integer, integer, text[], text, text, boolean) to authenticated, anon;
revoke all on function public.confirm_ygo_market_variant(text, uuid, text) from public, anon, authenticated;
grant execute on function public.confirm_ygo_market_variant(text, uuid, text) to authenticated, anon;

commit;
