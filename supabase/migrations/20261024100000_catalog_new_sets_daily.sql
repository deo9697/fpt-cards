-- F.P.T Cards — Controllo giornaliero dei set Yu-Gi-Oh! nuovi (2026-10-24).
-- Caso reale: Beyond the Brave (BETB) uscito l'8/10, dopo il riempimento del
-- catalogo del 13/10 → 9 stampe su 303, Fast Scan cieca su quel set.
-- La funzione catalog-new-sets confronta i set usciti di recente con il
-- catalogo e aggiunge solo stampe confermate da più fonti (vedi plan.ts).
-- Additiva: una tabella di log (solo service role) + un job pg_cron.

create table if not exists public.catalog_auto_sync_runs (
  id bigint generated always as identity primary key,
  ran_at timestamptz not null default now(),
  status text not null check (status in ('ok','error')),
  inserted_rows integer not null default 0 check (inserted_rows >= 0),
  report jsonb not null default '{}'::jsonb
);
create index if not exists catalog_auto_sync_runs_ran_at_idx on public.catalog_auto_sync_runs (ran_at desc);
alter table public.catalog_auto_sync_runs enable row level security;
revoke all on public.catalog_auto_sync_runs from public, anon, authenticated;
grant select, insert on public.catalog_auto_sync_runs to service_role;
grant usage on sequence public.catalog_auto_sync_runs_id_seq to service_role;

-- 03:30 UTC, dopo i job di mercato delle 01:00/02:00. Stesso segreto e stesso
-- schema dei job 5 e 6.
select cron.unschedule(jobid) from cron.job where jobname = 'catalog-new-sets-daily';
select cron.schedule('catalog-new-sets-daily', '30 3 * * *', $cron$
  select net.http_post(
    url := 'https://gonycawupahawocqafcf.supabase.co/functions/v1/catalog-new-sets',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'x-market-sync-secret', (select decrypted_secret from vault.decrypted_secrets where name='market_sync_secret')
    ),
    body := '{"scheduled":true}'::jsonb,
    timeout_milliseconds := 150000
  );
$cron$);
