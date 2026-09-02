\set ON_ERROR_STOP on
select md5(jsonb_build_object(
  'mappings',(select jsonb_agg(to_jsonb(x) order by id) from (select id,printing_id,provider,provider_product_id,variant_key,resolution_status,confidence,provider_metadata from public.market_provider_printings) x),
  'snapshots',(select jsonb_agg(to_jsonb(x) order by id) from (select id,printing_id,provider_mapping_id,provider,price_type,normalized_price,observation_key,metadata from public.market_price_snapshots) x),
  'events',(select jsonb_agg(to_jsonb(x) order by id) from (select id,printing_id,provider,previous_snapshot_id,current_snapshot_id,previous_price,current_price,absolute_change,percentage_change from public.market_price_events) x),
  'runs',(select jsonb_agg(to_jsonb(x) order by id) from (select id,provider,status,request_count,attempt_count,metadata from public.market_provider_sync_runs) x)
)::text) as data_fingerprint;

select md5(string_agg(definition,E'\n' order by object_name)) as schema_fingerprint
from (
  select 'view:'||c.relname object_name,pg_get_viewdef(c.oid,true) definition
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relname in ('market_latest_prices')
  union all
  select 'function:'||p.oid::regprocedure::text,pg_get_functiondef(p.oid)
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname in ('list_market_watch','list_market_price_history','list_market_dashboard_movers')
) definitions;
