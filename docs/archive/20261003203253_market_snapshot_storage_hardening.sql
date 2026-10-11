-- ARCHIVED LIVE RECORD ONLY. Abandoned rolling strategy; do not apply.
-- Original live migration version retained for ledger reconciliation, not migration replay.
begin;

create or replace function public.trg_market_current_price_snapshot_after_value_update()
returns trigger language plpgsql set search_path = public as $$
begin
  perform public.sync_market_current_price_snapshot(new);
  return null;
end;
$$;

drop trigger if exists market_current_price_snapshot_after_value_update on public.market_price_snapshots;
create trigger market_current_price_snapshot_after_value_update
after update of original_currency, original_price, normalized_currency,
  normalized_price, language, condition_reference, foil, available_quantity,
  sample_size, source_updated_at, captured_at, metadata
on public.market_price_snapshots
for each row execute function public.trg_market_current_price_snapshot_after_value_update();

-- is_anomalous remains owned by market_current_price_snapshot_after_anomaly_change.
revoke all on function public.trg_market_current_price_snapshot_after_value_update()
  from public, anon, authenticated;

notify pgrst, 'reload schema';
commit;
