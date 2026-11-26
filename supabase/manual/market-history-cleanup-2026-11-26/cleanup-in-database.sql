-- Pulizia una tantum dello storico prezzi (2026-11-26).
-- Il database era a 1.227 MB su 500 (piano gratuito) e Supabase l'ha messo in
-- sola lettura: 1.061 MB erano market_price_snapshots (1,26 milioni di righe,
-- 6 tipi di prezzo al giorno per ~3.600 stampe, mai cancellate).
-- Backup completo prima di eseguire: Desktop/PROGETTONI WOWOWOW/backup-supabase-2026-11-26.
--
-- Cosa si tiene (stesse regole di public.prune_market_price_history):
--   * le righe a cui puntano i prezzi attuali (market_current_price_snapshots)
--     e gli eventi degli ultimi 14 giorni;
--   * le anomalie (is_anomalous);
--   * le ultime 2 rilevazioni di ogni serie;
--   * trend (o qualunque tipo, per una stampa senza trend): 1 al giorno per 30
--     giorni, 1 a settimana fino a 90 giorni, 1 al mese oltre.
-- Eventi: si tengono gli ultimi 14 giorni (nessuna funzione o pagina li legge).
--
-- Perché TRUNCATE + reinserimento invece di DELETE: un DELETE non restituisce
-- spazio (servirebbe VACUUM FULL, che non può girare in una transazione). Con
-- TRUNCATE tabelle e indici ripartono compatti, e tutto resta in UNA transazione:
-- se un controllo fallisce non cambia nulla.
set session characteristics as transaction read write;

begin;
set local statement_timeout = '25min';
set local lock_timeout = '60s';
lock table public.market_price_snapshots, public.market_price_events, public.market_current_price_snapshots in access exclusive mode;

create temp table keep_ids on commit drop as
with has_trend as (
  select distinct printing_id from public.market_price_snapshots where price_type = 'trend'
), s as (
  select m.id, m.captured_at, m.is_anomalous,
    (m.price_type = 'trend' or ht.printing_id is null) as history_series,
    row_number() over (partition by m.printing_id, m.provider_mapping_id, m.provider, m.price_type, m.normalized_currency order by m.captured_at desc, m.id desc) as rn,
    row_number() over (partition by m.printing_id, m.provider_mapping_id, m.provider, m.price_type, m.normalized_currency, date_trunc('day', m.captured_at) order by m.captured_at desc, m.id desc) as rn_day,
    row_number() over (partition by m.printing_id, m.provider_mapping_id, m.provider, m.price_type, m.normalized_currency, date_trunc('week', m.captured_at) order by m.captured_at desc, m.id desc) as rn_week,
    row_number() over (partition by m.printing_id, m.provider_mapping_id, m.provider, m.price_type, m.normalized_currency, date_trunc('month', m.captured_at) order by m.captured_at desc, m.id desc) as rn_month
  from public.market_price_snapshots m left join has_trend ht on ht.printing_id = m.printing_id
), pinned as (
  select snapshot_id as id from public.market_current_price_snapshots
  union select previous_snapshot_id from public.market_price_events where detected_at >= now() - interval '14 days'
  union select current_snapshot_id from public.market_price_events where detected_at >= now() - interval '14 days'
)
select s.id from s left join pinned p on p.id = s.id
where p.id is not null or s.is_anomalous or s.rn <= 2
  or (s.history_series and s.rn_day = 1 and s.captured_at >= now() - interval '30 days')
  or (s.history_series and s.rn_week = 1 and s.captured_at >= now() - interval '90 days')
  or (s.history_series and s.rn_month = 1);
alter table keep_ids add primary key (id);

create temp table keep_snap on commit drop as select m.* from public.market_price_snapshots m join keep_ids k using (id);
create temp table keep_events on commit drop as select * from public.market_price_events where detected_at >= now() - interval '14 days';
create temp table keep_current on commit drop as select * from public.market_current_price_snapshots;

do $$
declare before_snap bigint; kept bigint;
begin
  select count(*) into before_snap from public.market_price_snapshots;
  select count(*) into kept from keep_snap;
  if kept = 0 or kept >= before_snap then raise exception 'cleanup: insieme da tenere anomalo (% su %)', kept, before_snap; end if;
  if exists (select 1 from keep_current c where not exists (select 1 from keep_snap s where s.id = c.snapshot_id)) then
    raise exception 'cleanup: un prezzo attuale perderebbe la sua rilevazione';
  end if;
  if exists (select 1 from keep_events e where not exists (select 1 from keep_snap s where s.id = e.previous_snapshot_id)
                                          or not exists (select 1 from keep_snap s where s.id = e.current_snapshot_id)) then
    raise exception 'cleanup: un evento recente perderebbe una rilevazione';
  end if;
  raise notice 'cleanup: tengo % rilevazioni su %', kept, before_snap;
end $$;

-- CASCADE svuota anche eventi e prezzi attuali (le sole tabelle che puntano qui).
truncate table public.market_price_snapshots cascade;

-- Reinserimento senza trigger: niente nuovi eventi, anomalie o ricalcoli del prezzo attuale.
alter table public.market_price_snapshots disable trigger user;
insert into public.market_price_snapshots select * from keep_snap;
alter table public.market_price_snapshots enable trigger user;
insert into public.market_price_events select * from keep_events;
insert into public.market_current_price_snapshots select * from keep_current;

do $$
begin
  if (select count(*) from public.market_price_snapshots) <> (select count(*) from keep_snap)
     or (select count(*) from public.market_price_events) <> (select count(*) from keep_events)
     or (select count(*) from public.market_current_price_snapshots) <> (select count(*) from keep_current) then
    raise exception 'cleanup: conteggi finali diversi dal previsto';
  end if;
end $$;

commit;

analyze public.market_price_snapshots;
analyze public.market_price_events;
analyze public.market_current_price_snapshots;

select pg_size_pretty(pg_database_size(current_database())) as database_size,
  (select count(*) from public.market_price_snapshots) as snapshots,
  (select count(*) from public.market_price_events) as events,
  (select count(*) from public.market_current_price_snapshots) as current_prices;
