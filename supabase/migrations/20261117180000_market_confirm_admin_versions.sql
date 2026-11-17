-- Market Watch: conferma versioni solo per gli admin + dettagli di ogni versione (2026-11-17)
--
-- Richiesta dell'utente: la conferma delle versioni Cardmarket è uno strumento
-- da admin (dev), e confermando bisogna capire QUALE rarità si sta scegliendo.
-- Cardmarket non pubblica la rarità: market-sync salva per ogni versione il
-- prezzo e la rarità stimata (_shared/variant-evidence.js describeVersions).
--   1. ygo_market_variants.candidate_details: [{productId, version, price, rarity, among}]
--   2. list_market_confirm_queue: vuota per chi non è admin; restituisce le versioni
--   3. confirm_market_variant_choice: solo admin
-- Rieseguibile.

begin;

alter table public.ygo_market_variants
  add column if not exists candidate_details jsonb not null default '[]'::jsonb;

create or replace function public.list_market_confirm_queue(p_token text, p_game text default 'yugioh'::text)
returns jsonb
language plpgsql security definer set search_path to 'public', 'extensions' as $function$
declare me text := public.session_member(p_token); result jsonb;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  if not coalesce((select role = 'admin' from public.team_members where slug = me), false) then
    return jsonb_build_object('items', '[]'::jsonb);
  end if;

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
      case when v.mapping_status = 'ambiguous' and v.resolution_reason = 'evidence_suggestion' then v.mapping_notes end suggestion_note,
      coalesce(v.candidate_details, '[]'::jsonb) versions
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
  if not coalesce((select role = 'admin' from public.team_members where slug = me), false) then raise exception 'Operazione riservata agli admin'; end if;
  if chosen = '' then raise exception 'Product ID Cardmarket mancante'; end if;

  select coalesce(provider_metadata->'candidateProductIds', '[]'::jsonb) into candidates
  from public.market_provider_printings
  where printing_id = p_printing_id and provider = 'cardmarket' and variant_key = 'default';
  if jsonb_typeof(candidates) <> 'array' then candidates := '[]'::jsonb; end if;
  if jsonb_array_length(candidates) > 1 and not exists (select 1 from jsonb_array_elements_text(candidates) c where c = chosen) then
    raise exception 'Il prodotto scelto non è tra le versioni note di questa carta';
  end if;

  perform public.set_market_mapping_manual(p_token, p_printing_id, chosen, p_product_name, p_expansion, p_rarity);
  update public.market_provider_printings
     set provider_metadata = provider_metadata || jsonb_build_object('confirmMode', 'single')
   where printing_id = p_printing_id and provider = 'cardmarket' and variant_key = 'default';

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

commit;
