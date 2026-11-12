-- Market Watch: avvisi giornalieri sulle carte possedute, minimo 2 EUR/copia.
-- Applicazione manuale; NON abilita cron e NON esegue lo scan.
-- Prerequisiti: Market Watch/current-price layer, notifications, Push 2.0.
begin;

create table if not exists public.market_owned_alert_state (
  member_slug text not null references public.team_members(slug) on delete cascade,
  printing_id uuid not null references public.card_printings(id) on delete cascade,
  last_snapshot_id uuid not null,
  last_notified_at timestamptz,
  primary key (member_slug, printing_id)
);
alter table public.market_owned_alert_state enable row level security;
create index if not exists market_owned_alert_state_printing_idx on public.market_owned_alert_state(printing_id);
revoke all on public.market_owned_alert_state from public, anon, authenticated;
grant select, insert, update, delete on public.market_owned_alert_state to service_role;

create or replace function public.run_market_alert_scan()
returns integer language plpgsql security definer set search_path = '' as $$
declare
  r record; prior record; cursor_row public.market_owned_alert_state%rowtype;
  delta numeric; threshold numeric; quiet interval;
  notified integer := 0;
begin
  -- A single transaction owns the scan, including the notification insert/cursor.
  if not pg_try_advisory_xact_lock(741029, 2) then return 0; end if;

  delete from public.market_owned_alert_state st where not exists (
    select 1 from public.collection_items ci where ci.owner_slug = st.member_slug
      and ci.printing_id = st.printing_id and ci.quantity_owned > 0
  );

  for r in
    with owned as materialized (
      select distinct ci.owner_slug member_slug, ci.printing_id
      from public.collection_items ci join public.team_members tm on tm.slug = ci.owner_slug and tm.active
      where ci.quantity_owned > 0 and ci.printing_id is not null
    ), prices as materialized (
      select distinct on (c.printing_id) c.*, s.metadata, s.is_anomalous,
        m.provider_metadata, m.resolution_status
      from public.market_current_price_snapshots c
      join public.market_price_snapshots s on s.id = c.snapshot_id
      join public.market_provider_printings m on m.id = c.provider_mapping_id
      where c.printing_id in (select printing_id from owned) and c.provider = 'cardmarket'
        and public.market_mapping_is_active(m.provider, m.resolution_status, m.provider_metadata)
        and c.normalized_currency = 'EUR' and c.normalized_price > 0
      order by c.printing_id, public.market_reference_type(c.provider, c.price_type), c.captured_at desc, c.snapshot_id desc
    )
    select o.member_slug, p.*, cp.card_name, cp.set_code, cp.game,
      coalesce(pp.enabled, dp.enabled, true) enabled,
      coalesce(pp.direction, dp.direction, 'both') direction,
      coalesce(pp.up_absolute_threshold, pp.absolute_threshold, dp.up_absolute_threshold, dp.absolute_threshold, 2) up_threshold,
      coalesce(pp.down_absolute_threshold, pp.absolute_threshold, dp.down_absolute_threshold, dp.absolute_threshold, 2) down_threshold,
      coalesce(pp.cooldown, dp.cooldown, interval '24 hours') cooldown
    from owned o join prices p on p.printing_id = o.printing_id
    join public.card_printings cp on cp.id = p.printing_id
    left join public.market_alert_preferences pp on pp.member_slug = o.member_slug and pp.printing_id = o.printing_id
    left join public.market_alert_preferences dp on dp.member_slug = o.member_slug and dp.printing_id is null
  loop
    select * into cursor_row from public.market_owned_alert_state
      where member_slug = r.member_slug and printing_id = r.printing_id for update;
    if not found then
      -- First observation establishes a cursor; never send the historical backlog.
      insert into public.market_owned_alert_state(member_slug, printing_id, last_snapshot_id)
        values (r.member_slug, r.printing_id, r.snapshot_id);
      continue;
    end if;
    if cursor_row.last_snapshot_id = r.snapshot_id then continue; end if;
    update public.market_owned_alert_state set last_snapshot_id = r.snapshot_id
      where member_slug = r.member_slug and printing_id = r.printing_id;

    if not r.enabled or r.is_anomalous or r.captured_at < now() - interval '36 hours'
      or r.captured_at > now() then continue; end if;
    -- A new mapping/variant estimate is not a movement in the same card's price.
    if coalesce(r.metadata->'priceScope'->>'product', '') = 'minimum_across_candidates' then continue; end if;
    if coalesce(jsonb_array_length(case when jsonb_typeof(r.provider_metadata->'candidateProductIds') = 'array'
      then r.provider_metadata->'candidateProductIds' else '[]'::jsonb end), 0) > 1
      and coalesce(r.metadata->'priceScope'->>'product', '') <> 'exact_variant' then continue; end if;

    -- Previous daily observation, tolerating a 23-hour DST day / sync scheduling.
    -- Same mapping, type, currency, physical variant and scope. Ignore anomalous data.
    select s.* into prior from public.market_price_snapshots s
      where s.printing_id = r.printing_id and s.provider_mapping_id = r.provider_mapping_id
        and s.provider = r.provider and s.price_type = r.price_type
        and s.normalized_currency = 'EUR' and s.normalized_price > 0 and not s.is_anomalous
        and s.captured_at <= r.captured_at - interval '20 hours'
        and s.captured_at >= r.captured_at - interval '48 hours'
        and s.language is not distinct from r.language
        and s.condition_reference is not distinct from r.condition_reference
        and s.foil is not distinct from r.foil
        and s.metadata->'priceScope' is not distinct from r.metadata->'priceScope'
        and s.metadata->>'productUrl' is not distinct from r.metadata->>'productUrl'
        and s.metadata->>'variantKey' is not distinct from r.metadata->>'variantKey'
      order by s.captured_at desc, s.id desc limit 1;
    if not found then continue; end if;
    delta := r.normalized_price - prior.normalized_price;
    -- Never let legacy percentage/default-1-EUR preferences bypass the 2-EUR floor.
    threshold := greatest(2, case when delta > 0 then r.up_threshold else r.down_threshold end);
    quiet := greatest(interval '24 hours', r.cooldown);
    if abs(delta) < threshold or delta = 0
      or (r.direction = 'up' and delta < 0) or (r.direction = 'down' and delta > 0)
      or cursor_row.last_notified_at > now() - quiet then continue; end if;

    insert into public.notifications(member_slug, category, title, body, route_page, route_params, dedup_key, source_table, source_id)
      values (r.member_slug, 'market_alert', left(r.card_name, 120),
        format('%s: %s € → %s € (%s%s € per carta).',
          case when delta > 0 then 'Prezzo salito' else 'Prezzo sceso' end,
          replace(to_char(prior.normalized_price, 'FM9999999990.00'), '.', ','),
          replace(to_char(r.normalized_price, 'FM9999999990.00'), '.', ','),
          case when delta > 0 then '+' else '−' end,
          replace(to_char(abs(delta), 'FM9999999990.00'), '.', ',')),
        'collection', jsonb_build_object('printingId', r.printing_id, 'game', r.game),
        'market_owned:' || r.printing_id || ':' || r.snapshot_id, 'market_price_snapshots', r.snapshot_id)
      on conflict (member_slug, dedup_key) do nothing;
    if found then
      notified := notified + 1;
      update public.market_owned_alert_state set last_notified_at = now()
        where member_slug = r.member_slug and printing_id = r.printing_id;
    end if;
  end loop;
  return notified;
end;
$$;

create or replace function public.market_alert_scan_gate()
returns void language plpgsql security definer set search_path = '' as $$
begin
  if extract(hour from now() at time zone 'Europe/Rome') = 4 then
    perform public.run_market_alert_scan();
  end if;
end;
$$;
revoke all on function public.run_market_alert_scan(), public.market_alert_scan_gate() from public, anon, authenticated;
grant execute on function public.run_market_alert_scan(), public.market_alert_scan_gate() to service_role;
commit;
