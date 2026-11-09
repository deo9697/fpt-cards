-- Catalogo One Piece aggiornato da solo ogni giorno.
--
-- Fino a oggi onepiece-catalog-sync veniva lanciata solo a mano (ultima volta
-- 2026-09-11), quindi le espansioni nuove (es. EB-05) non arrivavano in app.
-- Il sync è idempotente (upsert sulla identity key) e fa 4-5 chiamate OPTCG
-- in tutto, mai una per carta: una volta al giorno è leggero.
--
-- Usa lo stesso secret Vault degli altri job (market_sync_secret ->
-- x-market-sync-secret): la function lo accetta dalla versione che
-- legge MARKET_SYNC_SECRET (deploy richiesto prima di questo cron).

select cron.unschedule(jobid) from cron.job where jobname = 'onepiece-catalog-sync-daily';
select cron.schedule('onepiece-catalog-sync-daily', '45 3 * * *', $cron$
  select net.http_post(
    url := 'https://gonycawupahawocqafcf.supabase.co/functions/v1/onepiece-catalog-sync',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'x-market-sync-secret', (select decrypted_secret from vault.decrypted_secrets where name='market_sync_secret')
    ),
    body := '{"scheduled":true}'::jsonb,
    timeout_milliseconds := 150000
  );
$cron$);
