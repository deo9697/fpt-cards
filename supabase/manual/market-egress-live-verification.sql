-- READ ONLY. Run sections at the indicated steps, not before their prerequisites.
-- H1: BEFORE rollout. Expect IDs 5/6, active=false, runs=0, UTC/GMT timezone.
select jobid,jobname,schedule,active,
  substring(command from 'functions/v1/([a-zA-Z0-9_-]+)') endpoint
from cron.job where jobid in (5,6) order by jobid;
select count(*) active_sync_runs from public.market_provider_sync_runs where status='running';
select count(*) queued_market_http_requests from net.http_request_queue
where url like 'https://gonycawupahawocqafcf.supabase.co/functions/v1/market%';
select current_setting('cron.timezone',true) cron_timezone;
select count(*) nonempty_sync_secrets from vault.decrypted_secrets
where name='market_sync_secret' and nullif(decrypted_secret,'') is not null;

-- H2: AFTER RPC installation. Expect false for prosecdef, invoker fixed path,
-- anon/auth false, service true; service_role should retain its existing BYPASSRLS.
select p.prosecdef,p.provolatile,p.proconfig,pg_get_function_result(p.oid) result_type
from pg_proc p where p.oid='public.market_refresh_queue_pending()'::regprocedure;
select r,has_function_privilege(r,'public.market_refresh_queue_pending()','EXECUTE') can_execute
from unnest(array['anon','authenticated','service_role']) r;
select rolname,rolbypassrls from pg_roles where rolname='service_role';
select t,has_table_privilege('service_role',t,'SELECT') backend_can_read
from unnest(array['public.market_monitored_printings','public.card_printings',
  'public.market_provider_printings','public.market_price_snapshots',
  'public.collection_items','public.deck_cards','public.decks','public.market_watch_items']) t;
begin read only;
set local role service_role;
select public.market_refresh_queue_pending() pending;
rollback;

-- H3: AFTER queue canary. Match id with queue_canary_request_id from the invocation.
-- Do not infer success from pg_cron status: net.http_post is asynchronous.
select id,status_code,timed_out,error_msg,left(content,500) response,
  headers->>'sb-request-id' edge_request_id,created
from net._http_response where created>=now()-interval '15 minutes'
order by id desc limit 20;
-- Also inspect Edge logs for this invocation: queue_targeted, feed_bytes=0,
-- storage_bytes_read=0, event empty_skip_feed or deferred_until_daily.
-- SQL cannot prove Edge byte counters; do not treat missing logs as zero.

-- H4: AFTER cron alteration/reactivation and first real daily.
select jobid,jobname,schedule,active,command from cron.job where jobid in (5,6) order by jobid;
select jobid,status,start_time,end_time,return_message from cron.job_run_details
where jobid in (5,6) and start_time>=now()-interval '2 days'
order by start_time desc limit 20;
select id,provider,status,started_at,finished_at,error_code,error_message,metadata
from public.market_provider_sync_runs where started_at>=now()-interval '2 days'
order by started_at desc limit 10;
select tgname,pg_get_triggerdef(oid) definition from pg_trigger
where tgrelid='public.market_price_snapshots'::regclass and not tgisinternal;
select count(*) daily_rows,min(captured_at),max(captured_at),
  count(*) filter(where observation_key like '%:current') rolling_rows,
  count(*) filter(where is_anomalous) anomalous_rows
from public.market_price_snapshots where provider='cardmarket'
  and captured_at>=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC';
select count(*) duplicate_groups from (
  select provider,observation_key,price_type from public.market_price_snapshots
  where captured_at>=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC'
  group by provider,observation_key,price_type having count(*)>1
) d;
select count(*) invalid_event_ids from public.market_price_events
where detected_at>=now()-interval '2 days' and previous_snapshot_id=current_snapshot_id;
select count(*) current_rows,max(captured_at) latest_current from public.market_current_price_snapshots
where provider='cardmarket';
-- Compare runs/snapshot/current timestamps before and after daily. Zero events or
-- anomalies can be legitimate with unchanged/non-anomalous input; do not manufacture them live.
