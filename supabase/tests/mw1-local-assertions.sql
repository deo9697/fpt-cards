\set ON_ERROR_STOP on

do $$
declare
  snapshot_count integer;
  event_count integer;
  active_count integer;
  derived_count integer;
  latest_count integer;
  invoker_count integer;
begin
  select count(*) into snapshot_count from public.market_price_snapshots;
  if snapshot_count<>6 then raise exception 'snapshot storici modificati: %',snapshot_count; end if;
  select count(*) into event_count from public.market_price_events;
  if event_count<>2 then raise exception 'price event attesi 2, trovati %',event_count; end if;
  select count(*) into active_count from public.market_active_price_snapshots;
  if active_count<>2 then raise exception 'active snapshot attesi 2 (manuale+aggregate), trovati %',active_count; end if;
  select count(*) into derived_count from public.market_derived_price_snapshots;
  if derived_count<>1 then raise exception 'derived snapshot atteso solo manuale, trovati %',derived_count; end if;
  select count(*) into latest_count from public.market_latest_prices;
  if latest_count<>2 then raise exception 'latest prices attesi 2, trovati %',latest_count; end if;
  if public.market_mapping_is_active('cardmarket','resolved','{}'::jsonb) then raise exception 'legacy 0.88 ancora attivo'; end if;
  if not public.market_mapping_is_active('cardmarket','manual','{"active":"true"}'::jsonb) then raise exception 'manuale non attivo'; end if;
  if not public.market_mapping_is_active('cardmarket','resolved','{"active":"true","resolverStatus":"PROVIDER_AGGREGATE"}'::jsonb) then raise exception 'aggregate non attivo'; end if;
  if public.market_mapping_is_active('cardmarket','ambiguous','{"active":"false","resolverStatus":"AMBIGUOUS"}'::jsonb) then raise exception 'ambiguo attivo'; end if;
  select count(*) into invoker_count from pg_class where relname in ('market_active_price_snapshots','market_derived_price_snapshots','market_latest_prices') and reloptions @> array['security_invoker=true'];
  if invoker_count<>3 then raise exception 'security_invoker assente su una vista: %',invoker_count; end if;
  if has_table_privilege('anon','public.market_active_price_snapshots','select') or has_table_privilege('authenticated','public.market_derived_price_snapshots','select') then raise exception 'grant vista troppo ampi'; end if;
end $$;

select 'MW1_LOCAL_ASSERTIONS_OK' as result;
