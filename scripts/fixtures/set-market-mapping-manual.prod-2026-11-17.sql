CREATE OR REPLACE FUNCTION public.set_market_mapping_manual(p_token text, p_printing_id uuid, p_provider_product_id text, p_product_name text DEFAULT ''::text, p_expansion text DEFAULT ''::text, p_rarity text DEFAULT ''::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  me text := public.session_member(p_token);
  existing public.market_provider_printings;
  product_url text;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  -- Audit 2026-11-15: prezzi e mapping Cardmarket sono condivisi da tutti i team:
  -- li modifica solo il team F.P.T, non i team beta ospiti.
  if public.member_team(me) is distinct from public.core_team_id() then raise exception 'Funzione riservata al team F.P.T'; end if;
  if not exists(select 1 from public.card_printings where id=p_printing_id) then raise exception 'Printing non valida'; end if;
  if coalesce(trim(p_provider_product_id),'')='' then raise exception 'Product ID Cardmarket mancante'; end if;
  product_url := 'https://www.cardmarket.com/en/YuGiOh/Products/Singles?idProduct=' || trim(p_provider_product_id);

  select * into existing from public.market_provider_printings
    where printing_id=p_printing_id and provider='cardmarket' and variant_key='default';

  if existing.id is null then
    insert into public.market_provider_printings(
      printing_id,provider,variant_key,provider_product_id,condition_reference,
      resolution_status,confidence,resolved_at,last_checked_at,refresh_requested_at,provider_metadata
    ) values (
      p_printing_id,'cardmarket','default',trim(p_provider_product_id),'Price Guide Cardmarket',
      'manual',1,now(),now(),now(),
      jsonb_build_object('active',true,'resolverStatus','MANUAL_OVERRIDE','productName',p_product_name,
        'expansion',p_expansion,'rarity',p_rarity,'productUrl',product_url,
        'manualConfirmedBy',me,'manualConfirmedAt',now())
    );
  else
    update public.market_provider_printings set
      provider_product_id=trim(p_provider_product_id),
      resolution_status='manual',
      confidence=1,
      resolved_at=now(),
      last_checked_at=now(),
      refresh_requested_at=now(),
      last_error=null,
      provider_metadata=coalesce(existing.provider_metadata,'{}'::jsonb) || jsonb_build_object(
        'active',true,'resolverStatus','MANUAL_OVERRIDE','productName',p_product_name,
        'expansion',p_expansion,'rarity',p_rarity,'productUrl',product_url,
        'manualConfirmedBy',me,'manualConfirmedAt',now()
      ),
      updated_at=now()
    where id=existing.id;
  end if;
end;
$function$
;
