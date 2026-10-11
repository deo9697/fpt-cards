-- READ ONLY. Metadata/aggregates only: no secrets, feed bodies or user rows.
begin transaction read only;
select jobname,schedule,active,
  substring(command from 'functions/v1/([a-zA-Z0-9_-]+)') function_slug,
  command like '%"refreshQueue":true%' refresh_queue_json_literal
from cron.job where jobname like '%market%';
select jobname,regexp_matches(command,
  $$'(scheduled|refreshQueue|priorityQueue|pricesOnly|resolvePending|mode|source)'\s*,\s*([^,\n)]{1,80})$$,'g') body_flag
from cron.job where jobname like '%market%';
select count(*) targets,
  count(*) filter(where mapping_id is null or refresh_requested_at is not null) queue_targets,
  sum(octet_length(row_to_json(t)::text)) estimated_uncompressed_target_json_bytes
from public.market_sync_targets('cardmarket') t;
select regexp_replace(name,'^.*/','') file_name,count(*) objects,
  sum((metadata->>'size')::bigint) bytes,max((metadata->>'size')::bigint) largest_bytes,
  min(created_at) first_created,max(created_at) last_created
from storage.objects where bucket_id='market-feed-cache'
group by 1 order by 1;
select public from storage.buckets where id='market-feed-cache';
select status,count(*) runs,
  count(*) filter(where metadata->>'targets'='0') explicit_zero_target_runs,
  min(started_at) first_run,max(started_at) last_run
from public.market_provider_sync_runs
where started_at>now()-interval '48 hours' group by status;
rollback;
