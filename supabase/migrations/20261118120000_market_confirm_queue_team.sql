-- Market Watch: coda di conferma versioni per TUTTO il team (2026-11-18)
--
-- Richiesta dell'utente: l'admin vedeva solo le carte della propria raccolta
-- da confermare; ora che ogni versione mostra prezzo e rarità stimata, vuole
-- sistemare a mano anche quelle dei compagni. La coda include le printing
-- possedute da qualunque membro attivo del team dell'admin e per ognuna dice
-- di chi sono (owners) e se l'admin stesso la possiede (mine).
-- Sempre vuota per chi non è admin. Rieseguibile.

begin;

create or replace function public.list_market_confirm_queue(p_token text, p_game text default 'yugioh'::text)
returns jsonb
language plpgsql security definer set search_path to 'public', 'extensions' as $function$
declare me text := public.session_member(p_token); my_team uuid; result jsonb;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  if not coalesce((select role = 'admin' from public.team_members where slug = me), false) then
    return jsonb_build_object('items', '[]'::jsonb);
  end if;
  my_team := public.member_team(me);

  with owned as (
    select ci.printing_id,
      jsonb_agg(distinct coalesce(nullif(trim(tm.full_name), ''), tm.slug)) owners,
      bool_or(ci.owner_slug = me) mine
    from public.collection_items ci
    join public.card_printings cp on cp.id = ci.printing_id
    join public.team_members tm on tm.slug = ci.owner_slug
    where cp.game = p_game
      and (ci.owner_slug = me or (tm.active is not false and tm.team_id is not distinct from my_team))
    group by ci.printing_id
  ), pending as (
    select cp.id printing_id, cp.card_name, cp.set_code, cp.set_name, cp.rarity, cp.image_url,
      cm.resolution_status mapping_status,
      coalesce(cm.provider_metadata->>'resolverStatus', cm.resolution_status) resolver_status,
      cm.provider_metadata->>'reason' mapping_reason,
      cm.provider_metadata->'evidence' mapping_evidence,
      case when v.mapping_status = 'ambiguous' and v.resolution_reason = 'evidence_suggestion' then v.cardmarket_product_id end suggested_product_id,
      case when v.mapping_status = 'ambiguous' and v.resolution_reason = 'evidence_suggestion' then v.mapping_notes end suggestion_note,
      coalesce(v.candidate_details, '[]'::jsonb) versions,
      o.owners, o.mine
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
