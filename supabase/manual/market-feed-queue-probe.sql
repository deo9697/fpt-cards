-- PREPARED ONLY. Apply before deploying either hardened Edge entrypoint.
-- Mirrors the existing market_sync_targets('cardmarket') queue predicate,
-- without projecting candidate metadata, names, languages or catalog rows.
begin;
create or replace function public.market_refresh_queue_pending()
returns boolean language sql stable security invoker
set search_path = ''
set statement_timeout = '10s'
as $$
  select exists (
    select 1
    from public.market_monitored_printings m
    join public.card_printings cp on cp.id=m.printing_id and cp.game='yugioh'
    left join public.market_provider_printings mp
      on mp.printing_id=cp.id and mp.provider='cardmarket'
    where mp.id is null
       or mp.refresh_requested_at is not null
       or (mp.resolution_status in ('resolved','manual') and not exists (
         select 1 from public.market_price_snapshots s
         where s.provider='cardmarket' and s.printing_id=cp.id
       ))
  );
$$;
revoke all on function public.market_refresh_queue_pending() from public,anon,authenticated;
grant execute on function public.market_refresh_queue_pending() to service_role;
grant select on public.market_monitored_printings, public.card_printings,
  public.market_provider_printings, public.market_price_snapshots,
  public.collection_items, public.deck_cards, public.decks,
  public.market_watch_items to service_role;
notify pgrst, 'reload schema';
commit;
