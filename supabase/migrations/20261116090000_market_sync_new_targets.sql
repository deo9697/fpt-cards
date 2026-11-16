-- Market Watch 2026-11-16: il job fpt-market-resolve-new-daily (00:30) falliva
-- ogni notte dal 2026-11-13 con 57014 (statement timeout) su
-- market_sync_targets pagina 1. resolveNew scaricava TUTTI i ~3.600 target
-- (ordinati e paginati, con sottoselect per lingua/edizione e un NOT EXISTS sugli
-- snapshot per ogni riga) solo per tenere quelli senza mapping (54).
-- market_sync_new_targets seleziona direttamente le printing monitorate senza
-- alcuna riga in market_provider_printings per il provider, con un limite, e
-- calcola lingua/edizione solo per quelle. Stesse colonne di market_sync_targets
-- così la Edge Function riusa lo stesso codice. Solo service_role.
begin;

create or replace function public.market_sync_new_targets(p_provider text, p_limit integer default 500)
returns table(mapping_id uuid, printing_id uuid, game text, catalog_card_id text, card_name text, set_code text, set_name text, rarity text, provider_product_id text, provider_blueprint_id text, provider_expansion_id text, variant_key text, language text, condition_reference text, foil boolean, edition text, resolution_status text, provider_metadata jsonb, refresh_requested_at timestamp with time zone)
language sql
stable
security definer
set search_path to 'public'
as $function$
  with missing as (
    select distinct m.printing_id
    from market_monitored_printings m
    where not exists (
      select 1 from market_provider_printings mp
      where mp.printing_id = m.printing_id and mp.provider = p_provider
    )
  ), picked as (
    select cp.*
    from missing x
    join card_printings cp on cp.id = x.printing_id
    where (p_provider <> 'cardmarket' or cp.game = 'yugioh')
    order by cp.id
    limit least(greatest(coalesce(p_limit, 500), 1), 2000)
  )
  select
    null::uuid, p.id, p.game, p.catalog_card_id, p.card_name, p.set_code, p.set_name, p.rarity,
    null::text, null::text, null::text, 'default'::text,
    coalesce((select min(ci.language) from collection_items ci where ci.printing_id = p.id), ''),
    'Price Guide Cardmarket'::text, null::boolean,
    coalesce((select min(ci.edition) from collection_items ci where ci.printing_id = p.id), ''),
    'unresolved'::text, '{}'::jsonb, null::timestamptz
  from picked p
  order by p.id;
$function$;

revoke all on function public.market_sync_new_targets(text, integer) from public, anon, authenticated;
grant execute on function public.market_sync_new_targets(text, integer) to service_role;

commit;
