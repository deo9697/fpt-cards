-- Storico prezzi sostenibile + avviso quota (2026-11-26).
-- Il 2026-11-23/24 il database ha superato i 500 MB del piano gratuito (1.227 MB,
-- di cui 1.061 MB di market_price_snapshots) ed è finito in sola lettura.
-- Pulizia una tantum: supabase/manual/market-history-cleanup-2026-11-26.sql.
-- Questa migration impedisce che ricapiti:
--   1. public.prune_market_price_history(): ogni notte applica le stesse regole
--      della pulizia (trend: giornaliero 30 g, settimanale fino a 90 g, mensile
--      oltre; altri tipi: ultime 2; sempre: prezzi attuali, anomalie, eventi 14 g);
--   2. gli eventi di prezzo solo per il trend (gli altri 5 tipi generavano ~5/6
--      dei ~75.000 eventi al mese, che nessuna funzione o pagina legge);
--   3. public.check_database_quota(): avvisa gli admin al 70/80/90% dei 500 MB.

-- 1. Retention giornaliera ---------------------------------------------------
create or replace function public.prune_market_price_history()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare deleted_events bigint; deleted_snapshots bigint;
begin
  delete from public.market_price_events where detected_at < now() - interval '14 days';
  get diagnostics deleted_events = row_count;

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
    union select previous_snapshot_id from public.market_price_events
    union select current_snapshot_id from public.market_price_events
  ), doomed as (
    select s.id from s left join pinned p on p.id = s.id
    where p.id is null and not s.is_anomalous and s.rn > 2
      and not (s.history_series and s.rn_day = 1 and s.captured_at >= now() - interval '30 days')
      and not (s.history_series and s.rn_week = 1 and s.captured_at >= now() - interval '90 days')
      and not (s.history_series and s.rn_month = 1)
  )
  delete from public.market_price_snapshots m using doomed d where m.id = d.id;
  get diagnostics deleted_snapshots = row_count;

  return jsonb_build_object('deleted_events', deleted_events, 'deleted_snapshots', deleted_snapshots,
    'database_bytes', pg_database_size(current_database()));
end;
$$;
revoke all on function public.prune_market_price_history() from public, anon, authenticated;

-- 2. Eventi solo per il trend -------------------------------------------------
create or replace function public.detect_market_price_event()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $function$
declare previous market_price_snapshots;
begin
  if new.normalized_price is null then return new; end if;
  -- 2026-11-26: medie e minimo restano come valore attuale, senza eventi.
  if new.price_type <> 'trend' then return new; end if;
  select * into previous from market_price_snapshots
    where printing_id=new.printing_id and provider=new.provider and price_type=new.price_type
      and normalized_price is not null and id<>new.id and captured_at<new.captured_at
    order by captured_at desc,id desc limit 1;
  if previous.id is null or previous.normalized_price=new.normalized_price then return new; end if;
  insert into market_price_events(printing_id,provider,previous_snapshot_id,current_snapshot_id,
    previous_price,current_price,absolute_change,percentage_change,detected_at)
  values(new.printing_id,new.provider,previous.id,new.id,previous.normalized_price,new.normalized_price,
    new.normalized_price-previous.normalized_price,
    case when previous.normalized_price=0 then null else ((new.normalized_price-previous.normalized_price)/previous.normalized_price)*100 end,
    new.captured_at)
  on conflict(previous_snapshot_id,current_snapshot_id) do nothing;
  return new;
end;
$function$;

-- 3. Avviso quota -------------------------------------------------------------
create or replace function public.check_database_quota(p_limit_bytes bigint default 500 * 1024 * 1024)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare used bigint := pg_database_size(current_database()); pct numeric; level int; notified int := 0;
begin
  pct := round(used * 100.0 / p_limit_bytes, 1);
  level := case when pct >= 90 then 90 when pct >= 80 then 80 when pct >= 70 then 70 else 0 end;
  if level > 0 then
    insert into public.notifications(member_slug, category, title, body, route_page, route_params, dedup_key, source_table)
    select tm.slug, 'system', format('Database al %s%%', level),
      format('Il database Supabase usa %s su %s (%s%%). Controlla lo storico prezzi prima che vada in sola lettura.',
        pg_size_pretty(used), pg_size_pretty(p_limit_bytes), pct),
      'settings', '{}'::jsonb, format('db-quota-%s-%s', level, to_char(now(), 'YYYY-MM')), 'database_quota'
    from public.team_members tm
    where tm.role = 'admin' and coalesce(tm.active, true)
    on conflict (member_slug, dedup_key) do nothing;
    get diagnostics notified = row_count;
  end if;
  return jsonb_build_object('used_bytes', used, 'percent', pct, 'level', level, 'notified', notified);
end;
$$;
revoke all on function public.check_database_quota(bigint) from public, anon, authenticated;

-- 4. Pianificazione (dopo market-sync 01:00/02:00 e il riepilogo dashboard 02:30 UTC)
select cron.unschedule(jobid) from cron.job where jobname in ('fpt-market-history-retention-daily', 'fpt-database-quota-daily');
select cron.schedule('fpt-market-history-retention-daily', '50 2 * * *', $$select public.prune_market_price_history();$$);
select cron.schedule('fpt-database-quota-daily', '0 4 * * *', $$select public.check_database_quota();$$);
