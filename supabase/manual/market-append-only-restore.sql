-- PREPARED ONLY: first restore/deploy the append-only writer and drain old runs.
-- Does not update/delete any snapshot or touch anomaly/INSERT lifecycle triggers.
-- Execute only after separately authorized review of the installed live definition.
begin;
set local lock_timeout = '2s';
drop trigger if exists market_current_price_snapshot_after_value_update on public.market_price_snapshots;
drop function if exists public.trg_market_current_price_snapshot_after_value_update();
notify pgrst, 'reload schema';
commit;
