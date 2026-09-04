-- F.P.T Cards — Market Watch: conferma manuale della printing Cardmarket.
-- Migration additiva: applicare dopo supabase-market-watch-lowest-price.sql.
-- Permette a un membro del team di confermare a mano quale prodotto
-- Cardmarket corrisponde a una printing quando il resolver automatico
-- l'ha marcata PROVIDER_AGGREGATE (prezzo indicativo, trend escluso).
-- Il prossimo sync programmato salta il re-resolve per le mapping
-- 'manual' (vedi supabase/functions/market-sync/index.ts,
-- resolveCardmarketTargets) e continua comunque a scaricarne il prezzo
-- (isAuthorizedCardmarketMapping in market/providers.js autorizza
-- resolution_status='manual' a prescindere dal resolverStatus).

create or replace function public.set_market_mapping_manual(
  p_token text,
  p_printing_id uuid,
  p_provider_product_id text,
  p_product_name text default '',
  p_expansion text default '',
  p_rarity text default ''
) returns void language plpgsql security definer set search_path=public,extensions as $$
declare
  me text := public.session_member(p_token);
  existing public.market_provider_printings;
  product_url text;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  if not exists(select 1 from public.card_printings where id=p_printing_id) then raise exception 'Printing non valida'; end if;
  if coalesce(trim(p_provider_product_id),'')='' then raise exception 'Product ID Cardmarket mancante'; end if;
  product_url := 'https://www.cardmarket.com/en/YuGiOh/Products/Singles?idProduct=' || trim(p_provider_product_id);

  select * into existing from public.market_provider_printings
    where printing_id=p_printing_id and provider='cardmarket' and variant_key='default';

  if existing.id is null then
    insert into public.market_provider_printings(
      printing_id,provider,variant_key,provider_product_id,condition_reference,
      resolution_status,confidence,resolved_at,last_checked_at,provider_metadata
    ) values (
      p_printing_id,'cardmarket','default',trim(p_provider_product_id),'Price Guide Cardmarket',
      'manual',1,now(),now(),
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
$$;

revoke all on function public.set_market_mapping_manual(text,uuid,text,text,text,text) from public,anon,authenticated;
grant execute on function public.set_market_mapping_manual(text,uuid,text,text,text,text) to anon,authenticated;

notify pgrst, 'reload schema';
