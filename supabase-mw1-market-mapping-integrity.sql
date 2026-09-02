-- MW1 Market Watch mapping integrity.
-- Non distruttiva: non modifica mapping o snapshot e non avvia alcun sync.
-- Applicare prima degli script operativi MW1 aggiornati, solo dopo il rollout approvato.

begin;

create or replace function public.market_mapping_is_active(
  p_provider text,
  p_resolution_status text,
  p_provider_metadata jsonb
)
returns boolean
language sql
immutable
set search_path=public
as $$
  select case
    when p_provider <> 'cardmarket'
      then p_resolution_status in ('resolved','manual')
    when p_resolution_status = 'manual'
      then coalesce(p_provider_metadata->>'active','true') <> 'false'
    else p_resolution_status = 'resolved'
      and coalesce(p_provider_metadata->>'active','false') = 'true'
      and p_provider_metadata->>'resolverStatus' in ('EXACT','PROVIDER_AGGREGATE')
  end;
$$;

revoke all on function public.market_mapping_is_active(text,text,jsonb) from public,anon,authenticated;

create or replace view public.market_active_price_snapshots
with (security_invoker=true) as
select s.*
from public.market_price_snapshots s
join public.market_provider_printings mp on mp.id=s.provider_mapping_id
where public.market_mapping_is_active(mp.provider,mp.resolution_status,mp.provider_metadata);

revoke all on public.market_active_price_snapshots from public,anon,authenticated;

create or replace view public.market_derived_price_snapshots
with (security_invoker=true) as
select s.*
from public.market_price_snapshots s
join public.market_provider_printings mp on mp.id=s.provider_mapping_id
where mp.resolution_status='manual'
   or (
     mp.resolution_status='resolved'
     and coalesce(mp.provider_metadata->>'active','false')='true'
     and mp.provider_metadata->>'resolverStatus'='EXACT'
   );

revoke all on public.market_derived_price_snapshots from public,anon,authenticated;

create or replace view public.market_latest_prices
with (security_invoker=true) as
select distinct on (s.printing_id,s.provider,s.price_type)
  s.id,s.printing_id,s.provider_mapping_id,s.provider,s.price_type,
  s.original_currency,s.original_price,s.normalized_currency,s.normalized_price,
  s.language,s.condition_reference,s.foil,s.available_quantity,s.sample_size,
  s.source_updated_at,s.captured_at,s.metadata
from public.market_active_price_snapshots s
order by s.printing_id,s.provider,s.price_type,s.captured_at desc,s.id desc;

revoke all on public.market_latest_prices from public,anon,authenticated;

notify pgrst, 'reload schema';
commit;

-- Rollback eseguibile: supabase-mw1-market-mapping-integrity-rollback.sql.
-- Non cancella mapping, snapshot, eventi o sync run.
