-- F.P.T Cards — fix: Fast Scan batch-save regression caused by the daily-mission
-- trigger on collection_items. Eseguire dopo supabase-milestone-10-daily-missions.sql.
--
-- Root cause: save_collection_batch()/save_fast_scan_chunk() upsert
-- collection_items one row at a time in a loop. The row-level trigger
-- mission_on_collection_change fires once per row, and the OLD
-- bump_daily_mission() did up to 3 separate round-trip statements per call
-- (insert-do-nothing, then a SELECT ... FOR UPDATE, then an UPDATE, plus a
-- conditional insert/select/update on member_progression when the mission
-- completes) — all serialized against the SAME (member_slug, mission_id,
-- mission_day) row for every item in the same scan session. A 25-card Fast
-- Scan chunk meant up to ~75-125 sequential statement round-trips just for
-- mission bookkeeping, compounding batch-save latency roughly linearly with
-- item count.
--
-- Fix: collapse bump_daily_mission()'s per-call work into ONE atomic
-- INSERT ... ON CONFLICT DO UPDATE ... RETURNING statement instead of a
-- separate insert/select-for-update/update sequence. Same semantics
-- (progress clamped to target, completed_at set exactly once, XP awarded
-- exactly once at the moment the target is crossed), just far fewer
-- round-trips per row. Deliberately does NOT touch save_collection_batch,
-- save_fast_scan_chunk, or any other write RPC — same "don't touch the
-- highest-traffic write paths" reasoning as supabase-milestone-10, this
-- fixes the trigger/helper side only.
--
-- How to verify after running: time a real Fast Scan save of a 20-25 card
-- chunk before/after applying this migration (this session has no live
-- Supabase access to benchmark it directly) — latency should no longer grow
-- noticeably with chunk size beyond the base upsert cost.

create or replace function public.bump_daily_mission(
  p_member text, p_mission_id text, p_target integer, p_delta integer, p_xp_reward integer
) returns void language plpgsql security definer set search_path = public, extensions as $$
declare just_completed boolean; total_before integer; total_after integer; level_after integer;
begin
  if p_member is null or p_delta <= 0 then return; end if;

  insert into public.member_daily_missions(member_slug, mission_id, mission_day, progress, target, completed_at)
    values (
      p_member, p_mission_id, current_date, least(p_target, p_delta), p_target,
      case when p_delta >= p_target then now() else null end
    )
  on conflict (member_slug, mission_id, mission_day) do update
    set progress = least(
          public.member_daily_missions.target,
          public.member_daily_missions.progress + excluded.progress
        ),
        completed_at = case
          when public.member_daily_missions.progress + excluded.progress >= public.member_daily_missions.target
            then now()
          else null
        end
  where public.member_daily_missions.completed_at is null
  returning (completed_at is not null) into just_completed;

  if not found or not just_completed or p_xp_reward <= 0 then return; end if;

  insert into public.member_progression(member_slug, total_xp, level) values (p_member, 0, 1)
    on conflict (member_slug) do nothing;
  select total_xp into total_before from public.member_progression where member_slug = p_member;
  total_after := total_before + p_xp_reward;
  level_after := public.level_from_xp(total_after);
  update public.member_progression set total_xp = total_after, level = level_after where member_slug = p_member;
end;
$$;

notify pgrst,'reload schema';
