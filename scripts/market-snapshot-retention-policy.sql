-- Shared classifier source, embedded verbatim by build-market-retention-sql.mjs.
-- Fixed windows; callers cannot supply a future cutoff or shorten retention.
with unknown_fk as (
  select c.oid from pg_catalog.pg_constraint c
  where c.contype='f' and c.confrelid='public.market_price_snapshots'::regclass
    and not (
      cardinality(c.conkey)=1 and cardinality(c.confkey)=1
      and c.confkey[1]=(select attnum from pg_catalog.pg_attribute where attrelid=c.confrelid and attname='id')
      and exists (
        select 1 from pg_catalog.pg_attribute a where a.attrelid=c.conrelid and a.attnum=c.conkey[1]
          and ((c.conrelid='public.market_current_price_snapshots'::regclass and a.attname='snapshot_id')
            or (c.conrelid='public.market_price_events'::regclass and a.attname in ('previous_snapshot_id','current_snapshot_id')))
      )
    )
), references_by_id as (
  select snapshot_id as id from public.market_current_price_snapshots
  union select previous_snapshot_id from public.market_price_events
  union select current_snapshot_id from public.market_price_events
), ranked as materialized (
  -- Per-mapping, per-currency protection also survives future mapping activation.
  -- Keep ties: some legacy readers do not have an ID tie-breaker.
  select s.*,pg_column_size(s)::bigint as stored_row_bytes,
    dense_rank() over (partition by printing_id,provider_mapping_id,provider,price_type,normalized_currency
      order by captured_at desc) as latest_rank
  from public.market_price_snapshots s
), valid_ranked as (
  select id, dense_rank() over (partition by printing_id,provider_mapping_id,provider,price_type,normalized_currency
    order by captured_at desc) as valid_rank
  from public.market_price_snapshots where not is_anomalous
), anchors as (
  -- The historical RPC fallbacks use <= cutoff, with NO lower age limit.
  -- Preserve sparse series boundaries, not just rows inside a time window.
  select printing_id,provider_mapping_id,provider,price_type,normalized_currency,
    max(captured_at) filter(where captured_at<=now()-interval '24 hours') as at_24h,
    max(captured_at) filter(where captured_at<=now()-interval '7 days') as at_7d,
    max(captured_at) filter(where captured_at<=now()-interval '30 days') as at_30d
  from public.market_price_snapshots
  where not is_anomalous and normalized_price is not null
  group by printing_id,provider_mapping_id,provider,price_type,normalized_currency
), facts as (
  select s.id, s.provider, s.price_type, s.captured_at,
    s.stored_row_bytes as estimated_row_bytes,
    ((s.provider='cardmarket' and s.price_type='trend')
      or (s.provider='cardtrader' and s.price_type='reference')) as primary_series,
    r.id is not null as fk_referenced,
    s.is_anomalous, s.observation_key like '%:current' as legacy_rolling,
    s.latest_rank<=2 or coalesce(v.valid_rank<=2,false) as latest_or_fallback,
    s.captured_at in (a.at_24h,a.at_7d,a.at_30d) as historical_anchor,
    (select count(*) from unknown_fk) as unknown_fk_blockers
  from ranked s
  left join references_by_id r on r.id=s.id
  left join valid_ranked v on v.id=s.id
  left join anchors a on a.printing_id=s.printing_id
    and a.provider_mapping_id is not distinct from s.provider_mapping_id
    and a.provider=s.provider and a.price_type=s.price_type
    and a.normalized_currency=s.normalized_currency
), classified as (
  select *, case
    when primary_series and captured_at>=now()-interval '365 days' then 'history_series'
    when fk_referenced or unknown_fk_blockers>0 then 'referenced'
    when captured_at>=now()-interval '35 days' or is_anomalous or legacy_rolling
      or latest_or_fallback or historical_anchor then 'retention_keep'
    else 'cleanup_candidate' end as bucket,
    case
    when primary_series and captured_at>=now()-interval '365 days' then 'primary_365d'
    when fk_referenced then 'current_or_event_fk'
    when unknown_fk_blockers>0 then 'unknown_fk_fail_closed'
    when is_anomalous then 'unresolved_anomaly'
    when legacy_rolling then 'legacy_rolling_quarantine'
    when captured_at>=now()-interval '35 days' then 'safety_window_35d'
    when latest_or_fallback then 'latest_two_or_valid_fallback'
    when historical_anchor then 'historical_delta_anchor'
    else 'expired_unreferenced_redundant' end as reason
  from facts
)
select id,provider,price_type,captured_at,estimated_row_bytes,bucket,reason,
  fk_referenced,unknown_fk_blockers from classified
