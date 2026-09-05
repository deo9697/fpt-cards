-- F.P.T Cards — Alert prezzo Market Watch (scan giornaliero).
-- MIGRAZIONE ADDITIVA NON APPLICATA AUTOMATICAMENTE.
-- Eseguire dopo supabase-notifications-center.sql e supabase-milestone-5-market-watch.sql.
-- Verificare prima che market_price_events esista davvero sul DB live:
--   select to_regclass('public.market_price_events');
-- Il cron.schedule in fondo resta commentato: non attivarlo prima del collaudo.
--
-- Niente editor in-app per le soglie: si usano i default (rialzo 2€ / ribasso
-- 1€) per tutti. Se in futuro serve una soglia diversa per una carta o un
-- membro specifico, si può inserire/aggiornare una riga in
-- market_alert_preferences direttamente da SQL — lo scan la userà comunque
-- (fallback automatico sul default quando non c'è nessuna riga).

-- market_alert_preferences esiste già (milestone 5) ma absolute_threshold/
-- direction da soli non bastano a esprimere "avvisami se sale di 2€ MA
-- scende di 1€" (due soglie diverse per verso). Due colonne opzionali, che
-- quando valorizzate hanno la precedenza sul vecchio absolute_threshold
-- simmetrico (lasciato intatto, non letto da nessun'altra parte).
alter table public.market_alert_preferences add column if not exists up_absolute_threshold numeric(14,4) check (up_absolute_threshold is null or up_absolute_threshold >= 0);
alter table public.market_alert_preferences add column if not exists down_absolute_threshold numeric(14,4) check (down_absolute_threshold is null or down_absolute_threshold >= 0);

-- Scan: per ogni (membro, printing) osservata in market_watch_items, guarda
-- l'ultimo evento di prezzo rilevato (market_price_events, già popolato in
-- automatico dal trigger detect_market_price_event della milestone 5) e
-- decide se notificare in base alla preferenza effettiva (riga specifica ->
-- riga default del membro -> fallback 2€ su / 1€ giù / 8% / 'both' / 24h).
-- Puro plpgsql: nessuna chiamata HTTP esterna necessaria (a differenza di
-- market-sync, che deve interrogare i provider di prezzo).
create or replace function public.run_market_alert_scan()
returns integer language plpgsql security definer set search_path=public as $$
declare
  r record;
  effective_up numeric; effective_down numeric; effective_pct numeric; effective_cooldown interval;
  direction_ok boolean; threshold_ok boolean; cooldown_ok boolean;
  dedup text; notified_count integer := 0;
begin
  for r in
    select w.member_slug, w.printing_id, cp.card_name,
      e.id as event_id, e.current_price, e.absolute_change, e.percentage_change,
      pp.id as pref_id, pp.up_absolute_threshold as pp_up, pp.down_absolute_threshold as pp_down,
      pp.absolute_threshold as pp_abs, pp.percentage_threshold as pp_pct, pp.direction as pp_dir,
      pp.enabled as pp_enabled, pp.cooldown as pp_cooldown, pp.last_notified_at as pp_last,
      dp.id as dp_id, dp.up_absolute_threshold as dp_up, dp.down_absolute_threshold as dp_down,
      dp.absolute_threshold as dp_abs, dp.percentage_threshold as dp_pct, dp.direction as dp_dir,
      dp.enabled as dp_enabled, dp.cooldown as dp_cooldown, dp.last_notified_at as dp_last
    from market_watch_items w
    join card_printings cp on cp.id = w.printing_id
    join lateral (
      select * from market_price_events e2 where e2.printing_id = w.printing_id
      order by e2.detected_at desc limit 1
    ) e on true
    left join market_alert_preferences pp on pp.member_slug = w.member_slug and pp.printing_id = w.printing_id
    left join market_alert_preferences dp on dp.member_slug = w.member_slug and dp.printing_id is null
  loop
    if not coalesce(r.pp_enabled, r.dp_enabled, true) then continue; end if;

    effective_up := coalesce(r.pp_up, r.pp_abs, r.dp_up, r.dp_abs, 2);
    effective_down := coalesce(r.pp_down, r.pp_abs, r.dp_down, r.dp_abs, 1);
    effective_pct := coalesce(r.pp_pct, r.dp_pct, 8);
    effective_cooldown := coalesce(r.pp_cooldown, r.dp_cooldown, interval '24 hours');

    direction_ok := case coalesce(r.pp_dir, r.dp_dir, 'both')
      when 'up' then r.absolute_change > 0
      when 'down' then r.absolute_change < 0
      else true end;

    threshold_ok := (r.absolute_change > 0 and (r.absolute_change >= effective_up or coalesce(abs(r.percentage_change),0) >= effective_pct))
      or (r.absolute_change < 0 and (abs(r.absolute_change) >= effective_down or coalesce(abs(r.percentage_change),0) >= effective_pct));

    cooldown_ok := coalesce(r.pp_last, r.dp_last) is null
      or coalesce(r.pp_last, r.dp_last) <= now() - effective_cooldown;

    if direction_ok and threshold_ok and cooldown_ok then
      dedup := 'market_alert:' || r.printing_id || ':' || r.event_id;
      insert into notifications(member_slug,category,title,body,route_page,route_params,dedup_key,source_table,source_id)
      values (
        r.member_slug, 'market_alert', r.card_name,
        case when r.absolute_change > 0
          then format('Prezzo salito di %s€ (ora %s€)', to_char(r.absolute_change,'FM999990.00'), to_char(r.current_price,'FM999990.00'))
          else format('Prezzo sceso di %s€ (ora %s€)', to_char(abs(r.absolute_change),'FM999990.00'), to_char(r.current_price,'FM999990.00'))
        end,
        'market', jsonb_build_object('printingId', r.printing_id),
        dedup, 'market_price_events', r.event_id
      )
      on conflict (member_slug, dedup_key) do nothing;

      if found then
        notified_count := notified_count + 1;
        if r.pref_id is not null then
          update market_alert_preferences set last_notified_price = r.current_price, last_notified_at = now() where id = r.pref_id;
        elsif r.dp_id is not null then
          update market_alert_preferences set last_notified_price = r.current_price, last_notified_at = now() where id = r.dp_id;
        else
          insert into market_alert_preferences(member_slug,printing_id,last_notified_price,last_notified_at)
            values (r.member_slug, null, r.current_price, now())
          on conflict (member_slug) where printing_id is null do update
            set last_notified_price = excluded.last_notified_price, last_notified_at = excluded.last_notified_at;
        end if;
      end if;
    end if;
  end loop;
  return notified_count;
end;
$$;

-- Il gate gestisce l'ora legale (pg_cron è in UTC, Europe/Rome no): lo scan
-- vero e proprio parte solo quando in Italia sono le 04:00, poco dopo il
-- sync prezzi delle 03:00 di market-sync, così l'alert riflette i prezzi
-- più freschi della giornata.
create or replace function public.market_alert_scan_gate()
returns void language plpgsql security definer set search_path=public as $$
begin
  if extract(hour from now() at time zone 'Europe/Rome') = 4 then
    perform public.run_market_alert_scan();
  end if;
end;
$$;

revoke all on function public.run_market_alert_scan(),public.market_alert_scan_gate() from public,anon,authenticated;
grant execute on function public.run_market_alert_scan(),public.market_alert_scan_gate() to service_role;

-- ESEMPIO NON ATTIVO. Non eseguire prima di aver collaudato manualmente
-- run_market_alert_scan() e verificato che market_price_events sia popolata.
-- select cron.schedule(
--   'fpt-market-alert-daily-gate',
--   '0 * * * *',
--   $$ select public.market_alert_scan_gate(); $$
-- );

notify pgrst,'reload schema';
