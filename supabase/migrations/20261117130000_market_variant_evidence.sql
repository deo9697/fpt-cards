-- Market Watch: conferma automatica delle versioni Cardmarket a indizi (2026-11-17)
--
-- Cardmarket non pubblica la rarità dei prodotti e la sua API non è aperta a
-- tutti. market-sync ora decide da solo quale versione è quella giusta quando
-- più indizi indipendenti sono d'accordo (_shared/variant-evidence.js), e
-- impara la posizione di ogni rarità in un set dalle conferme fatte carta per
-- carta. Questa migrazione aggiunge:
--   1. confirm_market_variant_choice  — conferma di UNA carta dalla coda:
--      fissa il mapping (come set_market_mapping_manual) E registra la scelta
--      come variante verificata, da cui il motore impara.
--   2. market_authorize_evidence_variant — solo service_role: una carta in coda
--      (AMBIGUOUS) decisa in automatico torna autorizzata, così ha subito il
--      prezzo esatto.
--   3. list_market_confirm_queue — esclude le carte che hanno già una variante
--      esatta (verificata o decisa in automatico) e restituisce il suggerimento
--      del motore per le altre.
-- Rieseguibile. Non tocca dati esistenti.

begin;

-- 1. Conferma di una singola carta ------------------------------------------
create or replace function public.confirm_market_variant_choice(
  p_token text, p_printing_id uuid, p_provider_product_id text,
  p_product_name text default '', p_expansion text default '', p_rarity text default ''
) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  me text := public.session_member(p_token);
  chosen text := trim(coalesce(p_provider_product_id, ''));
  candidates jsonb;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  if public.member_team(me) is distinct from public.core_team_id() then raise exception 'Funzione riservata al team F.P.T'; end if;
  if chosen = '' then raise exception 'Product ID Cardmarket mancante'; end if;

  select coalesce(provider_metadata->'candidateProductIds', '[]'::jsonb) into candidates
  from public.market_provider_printings
  where printing_id = p_printing_id and provider = 'cardmarket' and variant_key = 'default';
  if jsonb_typeof(candidates) <> 'array' then candidates := '[]'::jsonb; end if;
  if jsonb_array_length(candidates) > 1 and not exists (select 1 from jsonb_array_elements_text(candidates) c where c = chosen) then
    raise exception 'Il prodotto scelto non è tra le versioni note di questa carta';
  end if;

  -- Stessi controlli e stessa scrittura della conferma di sempre.
  perform public.set_market_mapping_manual(p_token, p_printing_id, chosen, p_product_name, p_expansion, p_rarity);
  update public.market_provider_printings
     set provider_metadata = provider_metadata || jsonb_build_object('confirmMode', 'single')
   where printing_id = p_printing_id and provider = 'cardmarket' and variant_key = 'default';

  -- La scelta diventa una variante verificata: prezzo esatto + base per imparare.
  insert into public.ygo_market_variants as v (
    printing_id, rarity_raw, cardmarket_product_id, candidate_product_ids,
    mapping_source, mapping_confidence, mapping_status, verified, verified_at, verified_by,
    resolution_reason, mapping_notes
  )
  select p_printing_id, left(coalesce(cp.rarity, ''), 100), chosen,
    case when jsonb_array_length(candidates) > 0 then candidates else jsonb_build_array(chosen) end,
    'manual', 1, 'verified', true, now(), me, 'single_card_confirmation', 'Confermata a mano da ' || me
  from public.card_printings cp where cp.id = p_printing_id
  on conflict (printing_id) do update set
    cardmarket_product_id = excluded.cardmarket_product_id,
    candidate_product_ids = case when jsonb_array_length(excluded.candidate_product_ids) > 1 then excluded.candidate_product_ids else v.candidate_product_ids end,
    mapping_source = 'manual', mapping_confidence = 1, mapping_status = 'verified',
    verified = true, verified_at = now(), verified_by = me,
    resolution_reason = 'single_card_confirmation', mapping_notes = excluded.mapping_notes;

  return jsonb_build_object('printingId', p_printing_id, 'cardmarketProductId', chosen, 'verified', true, 'verifiedBy', me);
end;
$$;
revoke all on function public.confirm_market_variant_choice(text, uuid, text, text, text, text) from public;
grant execute on function public.confirm_market_variant_choice(text, uuid, text, text, text, text) to anon, authenticated;

-- 2. Autorizzazione di una carta in coda decisa dal motore ---------------------
create or replace function public.market_authorize_evidence_variant(p_printing_id uuid, p_product_id text, p_note text default '')
returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  update public.market_provider_printings
     set resolution_status = 'resolved',
         provider_metadata = coalesce(provider_metadata, '{}'::jsonb) || jsonb_build_object(
           'resolverStatus', 'PROVIDER_AGGREGATE',
           'evidenceAuto', jsonb_build_object('productId', p_product_id, 'note', left(coalesce(p_note, ''), 500), 'at', now())),
         updated_at = now()
   where printing_id = p_printing_id and provider = 'cardmarket' and variant_key = 'default'
     and resolution_status <> 'manual'
     and provider_metadata->>'resolverStatus' = 'AMBIGUOUS'
     and exists (select 1 from jsonb_array_elements_text(coalesce(provider_metadata->'candidateProductIds', '[]'::jsonb)) c where c = p_product_id);
end;
$$;
revoke all on function public.market_authorize_evidence_variant(uuid, text, text) from public, anon, authenticated;
grant execute on function public.market_authorize_evidence_variant(uuid, text, text) to service_role;

-- 3. Coda di conferma: niente carte già esatte, suggerimento per le altre -------
create or replace function public.list_market_confirm_queue(p_token text, p_game text default 'yugioh'::text)
returns jsonb
language plpgsql security definer set search_path to 'public', 'extensions' as $function$
declare me text := public.session_member(p_token); result jsonb;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;

  with owned as (
    select distinct ci.printing_id
    from public.collection_items ci join public.card_printings cp on cp.id = ci.printing_id
    where ci.owner_slug = me and cp.game = p_game
  ), pending as (
    select cp.id printing_id, cp.card_name, cp.set_code, cp.set_name, cp.rarity, cp.image_url,
      cm.resolution_status mapping_status,
      coalesce(cm.provider_metadata->>'resolverStatus', cm.resolution_status) resolver_status,
      cm.provider_metadata->>'reason' mapping_reason,
      cm.provider_metadata->'evidence' mapping_evidence,
      case when v.mapping_status = 'ambiguous' and v.resolution_reason = 'evidence_suggestion' then v.cardmarket_product_id end suggested_product_id,
      case when v.mapping_status = 'ambiguous' and v.resolution_reason = 'evidence_suggestion' then v.mapping_notes end suggestion_note
    from owned o
    join public.card_printings cp on cp.id = o.printing_id
    join public.market_provider_printings cm on cm.printing_id = cp.id and cm.provider = 'cardmarket' and cm.variant_key = 'default'
    left join public.ygo_market_variants v on v.printing_id = cp.id
    where
      not coalesce(v.cardmarket_product_id is not null and (v.verified or (v.mapping_status = 'resolved' and coalesce(v.mapping_confidence, 0) >= 1)), false)
      and (
        (cm.resolution_status <> 'manual' and (cm.provider_metadata->>'reason' = 'provider_rarity_mismatch' or coalesce(cm.provider_metadata->>'resolverStatus', cm.resolution_status) = 'AMBIGUOUS'))
        or (coalesce(cm.provider_metadata->>'resolverStatus', cm.resolution_status) = 'PROVIDER_AGGREGATE'
          and (
            (case when jsonb_typeof(cm.provider_metadata->'evidence'->'candidates') = 'array' then jsonb_array_length(cm.provider_metadata->'evidence'->'candidates') > 0 else false end)
            or cm.provider_metadata->'evidence'->>'providerProductId' is not null
          ))
      )
  )
  select jsonb_build_object('items', coalesce(jsonb_agg(to_jsonb(pending) order by card_name, printing_id), '[]'::jsonb)) into result from pending;

  return coalesce(result, jsonb_build_object('items', '[]'::jsonb));
end;
$function$;

commit;
