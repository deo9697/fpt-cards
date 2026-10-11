-- PREPARED ONLY. Run phases separately; this file NEVER reactivates jobs by default.
-- PAUSE (committed even if a later precondition fails).
begin;
do $guard$
begin
  if (select count(*) from cron.job
      where (jobid=5 and jobname='fpt-market-refresh-queue')
         or (jobid=6 and jobname='fpt-market-sync-daily')) <> 2 then
    raise exception 'Unexpected cron IDs/names; stop without creating jobs';
  end if;
end;
$guard$;
select cron.alter_job(job_id:=5, active:=false);
select cron.alter_job(job_id:=6, active:=false);
commit;

-- ALTER COMMAND while paused, after deploying both functions and the private RPC.
begin;
do $guard$
begin
  if exists(select 1 from public.market_provider_sync_runs where status='running') then
    raise exception 'Active sync runs must be zero';
  end if;
  if coalesce(current_setting('cron.timezone',true),'GMT') not in ('GMT','UTC','Etc/UTC') then
    raise exception 'Expected UTC cron timezone';
  end if;
  if (select count(*) from vault.decrypted_secrets
      where name='market_sync_secret' and nullif(decrypted_secret,'') is not null) <> 1 then
    raise exception 'Expected exactly one nonempty market_sync_secret in Vault';
  end if;
  if to_regprocedure('public.market_refresh_queue_pending()') is null then
    raise exception 'Install private queue RPC first';
  end if;
end;
$guard$;
select cron.alter_job(job_id:=5, schedule:='5,20,35,50 * * * *',
  command:=$queue$
  select net.http_post(
    url := 'https://gonycawupahawocqafcf.supabase.co/functions/v1/market-refresh-queue-cached',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'x-market-sync-secret',
      (select decrypted_secret from vault.decrypted_secrets where name='market_sync_secret')
    ),
    body := '{"refreshQueue":true}'::jsonb,
    timeout_milliseconds := 30000
  );
  $queue$, active:=false);
select cron.alter_job(job_id:=6, schedule:='0 1,2 * * *',
  command:=$daily$
  select net.http_post(
    url := 'https://gonycawupahawocqafcf.supabase.co/functions/v1/market-sync',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'x-market-sync-secret',
      (select decrypted_secret from vault.decrypted_secrets where name='market_sync_secret')
    ),
    body := '{"mode":"daily_full","scheduled":true,"pricesOnly":true,"recoverStale":true}'::jsonb,
    timeout_milliseconds := 120000
  )
  where extract(hour from (now() at time zone 'Europe/Rome')) = 3;
  $daily$, active:=false);
commit;
-- Verification: both rows MUST remain inactive here. Command contains a Vault reference, not its value.
select jobid,jobname,schedule,active,command from cron.job where jobid in (5,6) order by jobid;

-- REACTIVATE: separate manual action ONLY AFTER the queue canary passes.
-- Copy/run these statements separately, in this order; do not uncomment before the canary.
-- select cron.alter_job(job_id:=5, active:=true);
-- select cron.alter_job(job_id:=6, active:=true);
-- select jobid,jobname,schedule,active from cron.job where jobid in (5,6) order by jobid;
