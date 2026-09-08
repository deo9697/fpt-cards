-- F.P.T Cards — Market Watch: coda di refresh prioritario dopo una conferma
-- manuale della mappatura. Migrazione additiva: eseguire dopo
-- supabase-market-mapping-manual-confirm.sql.
--
-- Perché una coda e non un refresh davvero istantaneo: loadCatalog()/
-- loadPrices() in supabase/functions/market-sync/index.ts scaricano SEMPRE
-- l'intero feed Cardmarket (catalogo + price guide) — non esiste un modo di
-- richiedere un solo prodotto. Un refresh "a click" richiamerebbe quindi lo
-- stesso costo di un sync completo ad ogni conferma manuale, e l'edge
-- function oggi si fida solo del secret statico server-side (MARKET_SYNC_
-- SECRET) — esporlo al client per un endpoint "refresh ora" significherebbe
-- darlo in mano a chiunque apra la pagina. Una coda a ciclo breve (ogni
-- ~15 minuti, job separato dal sync notturno) scarica il feed una sola
-- volta per ciclo e aggiorna in quel giro tutte le mappature confermate di
-- recente: non istantaneo ma nell'ordine dei minuti, senza replicare il
-- costo del sync completo per ogni singola conferma.

alter table public.market_provider_printings
  add column if not exists refresh_requested_at timestamptz;

-- Ogni conferma/riconferma manuale mette la propria mappatura in coda.
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
$$;

-- market_sync_targets deve esporre refresh_requested_at all'edge function
-- (CREATE OR REPLACE non basta: cambia la forma della tabella restituita).
drop function if exists public.market_sync_targets(text);
create function public.market_sync_targets(p_provider text)
returns table(mapping_id uuid,printing_id uuid,game text,catalog_card_id text,card_name text,set_code text,set_name text,rarity text,
  provider_product_id text,provider_blueprint_id text,provider_expansion_id text,variant_key text,language text,condition_reference text,foil boolean,edition text,resolution_status text,provider_metadata jsonb,refresh_requested_at timestamptz)
language sql security definer set search_path=public as $$
  with monitored as (select distinct printing_id from market_monitored_printings)
  select mp.id,cp.id,cp.game,cp.catalog_card_id,cp.card_name,cp.set_code,cp.set_name,cp.rarity,
    mp.provider_product_id,mp.provider_blueprint_id,mp.provider_expansion_id,coalesce(mp.variant_key,'default'),
    coalesce(nullif(mp.language,''),(select min(ci.language) from collection_items ci where ci.printing_id=cp.id),''),
    coalesce(nullif(mp.condition_reference,''),'Price Guide Cardmarket'),mp.foil,
    coalesce(nullif(mp.edition,''),(select min(ci.edition) from collection_items ci where ci.printing_id=cp.id),''),
    coalesce(mp.resolution_status,'unresolved'),coalesce(mp.provider_metadata,'{}'::jsonb),mp.refresh_requested_at
  from monitored m join card_printings cp on cp.id=m.printing_id
  left join market_provider_printings mp on mp.printing_id=cp.id and mp.provider=p_provider;
$$;
grant execute on function public.market_sync_targets(text) to service_role;

notify pgrst, 'reload schema';
