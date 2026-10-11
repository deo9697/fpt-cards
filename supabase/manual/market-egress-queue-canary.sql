-- MANUAL ONLY, after both deploys and paused cron alteration. No feed/DB data writes
-- by the Edge handler; net.http_post itself queues an HTTP request in pg_net.
begin;
do $guard$
begin
  if (select count(*) from cron.job where jobid in (5,6) and not active) <> 2
     or exists(select 1 from public.market_provider_sync_runs where status='running') then
    raise exception 'Both jobs must be paused and active sync runs zero';
  end if;
  if (select count(*) from vault.decrypted_secrets
      where name='market_sync_secret' and nullif(decrypted_secret,'') is not null) <> 1 then
    raise exception 'Expected one Vault sync secret';
  end if;
end;
$guard$;
select net.http_post(
  url := 'https://gonycawupahawocqafcf.supabase.co/functions/v1/market-refresh-queue-cached',
  headers := jsonb_build_object('Content-Type','application/json','x-market-sync-secret',
    (select decrypted_secret from vault.decrypted_secrets where name='market_sync_secret')),
  body := '{"refreshQueue":true}'::jsonb,
  timeout_milliseconds := 30000
) as queue_canary_request_id;
commit;
-- Record the returned ID; inspect its response in a NEW query after this commit.
-- Never print request headers or decrypted_secret.
