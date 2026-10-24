-- F.P.T Cards — Mappatura Cardmarket notturna delle carte nuove (2026-10-24).
-- Il giro notturno dei prezzi (job fpt-market-sync-daily) è pricesOnly per
-- contenere il traffico: non scarica il Product Catalogue, quindi non crea
-- mappature. Dal 2026-10-04 (job 15' rimandato al giro notturno) nient'altro le
-- creava: ultima mappatura il 18/09, 237 carte Yu-Gi-Oh senza Market Watch.
-- Questo job chiama market-sync con resolveNew: mappa SOLO le printing
-- monitorate senza alcuna mappatura; se non ce ne sono chiude senza scaricare
-- nulla. Alle 00:30 UTC, prima del giro prezzi delle 01:00, così le carte
-- mappate stanotte prendono il prezzo nello stesso giro.
-- allowFullFeed: autorizzazione esplicita richiesta dalla protezione del
-- traffico di market-sync; il catalogo si scarica comunque solo con carte nuove.
-- Additiva: un job pg_cron. Rollback: select cron.unschedule('fpt-market-resolve-new-daily');
select cron.unschedule(jobid) from cron.job where jobname = 'fpt-market-resolve-new-daily';
select cron.schedule('fpt-market-resolve-new-daily', '30 0 * * *', $cron$
  select net.http_post(
    url := 'https://gonycawupahawocqafcf.supabase.co/functions/v1/market-sync',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'x-market-sync-secret', (select decrypted_secret from vault.decrypted_secrets where name='market_sync_secret')
    ),
    body := '{"resolveNew":true,"resolverBatchSize":500,"allowFullFeed":true}'::jsonb,
    timeout_milliseconds := 150000
  );
$cron$);
