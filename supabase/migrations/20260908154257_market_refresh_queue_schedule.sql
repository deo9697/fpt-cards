-- The existing nightly job remains responsible for the complete price refresh.
-- This bounded queue handles new printings and confirmed mappings during the day.
do $$
begin
  if not exists(select 1 from vault.secrets where name='market_sync_secret') then
    raise exception 'market_sync_secret is required in Vault';
  end if;
end $$;
select cron.schedule(
  'fpt-market-refresh-queue',
  '*/15 * * * *',
  $job$
  select net.http_post(
    url := 'https://gonycawupahawocqafcf.supabase.co/functions/v1/market-sync',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'x-market-sync-secret',
      (select decrypted_secret from vault.decrypted_secrets where name='market_sync_secret')
    ),
    body := '{"refreshQueue":true}'::jsonb,
    timeout_milliseconds := 120000
  );
  $job$
);
