-- Solo dopo applicazione/revisione di market-owned-euro-alerts.sql e rilascio
-- del codice Push 2.0/routing. Questo file ATTIVA notifiche reali future.
-- Il primo scan, su stato vuoto, registra solo i cursori: nessun arretrato.
begin;
select public.run_market_alert_scan();
select cron.schedule('fpt-market-alert-daily-gate', '0 * * * *',
  $$select public.market_alert_scan_gate();$$);
commit;
-- Esecuzione giornaliera alle 04:00 Europe/Rome, dopo il sync prezzi.
-- Stop immediato (nessun dato cancellato):
-- select cron.unschedule(jobid) from cron.job where jobname='fpt-market-alert-daily-gate';
