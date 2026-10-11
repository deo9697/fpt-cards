-- PREPARED ONLY. SAFE-STOP: run only this first block to pause both jobs.
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

-- ROLLBACK CRON: restore supplied prior URL/body/guard/schedules, KEEP PAUSED.
-- Timeout 120 seconds follows the repository's original queue schedule.
-- Commands reproduce the supplied prior semantics, not original whitespace.
-- Does NOT roll back Edge code. Old wrapper source is in docs/audit-snapshots/
-- market-egress-2026-10-04/market-refresh-queue-cached-v2.ts.
begin;
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
    timeout_milliseconds := 120000
  );
  $queue$, active:=false);
select cron.alter_job(job_id:=6, schedule:='0 1,2 * * *',
  command:=$daily$
  select net.http_post(
    url := 'https://gonycawupahawocqafcf.supabase.co/functions/v1/market-refresh-queue-cached',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'x-market-sync-secret',
      (select decrypted_secret from vault.decrypted_secrets where name='market_sync_secret')
    ),
    body := jsonb_build_object('pricesOnly',true,'recoverStale',true,'source','daily_price_refresh'),
    timeout_milliseconds := 120000
  )
  where extract(hour from (now() at time zone 'Europe/Rome')) = 3;
  $daily$, active:=false);
commit;
select jobid,jobname,schedule,active,command from cron.job where jobid in (5,6) order by jobid;
-- No automatic reactivation: the old wrapper has the known egress regression.
-- Restored daily command requires the old wrapper code; the new wrapper defers it.
-- Prefer SAFE-STOP until a corrected direct daily is available.
