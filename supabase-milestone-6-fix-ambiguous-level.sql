-- F.P.T Cards — fix: get_my_progression falliva sempre con
-- "column reference 'level' is ambiguous".
-- Causa: la variabile locale "level" nella funzione aveva lo stesso nome
-- della colonna member_progression.level, e Postgres non riusciva a capire
-- se "level" nel SELECT ... INTO si riferisse alla colonna o alla variabile.
-- Rinominata la variabile in "member_level". Nessun'altra funzione della
-- migrazione precedente aveva questo problema (register_match/delete_match
-- usavano già level_before/level_after).
-- Eseguire dopo supabase-milestone-6-statistics-progression.sql.

create or replace function public.get_my_progression(p_token text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token); total integer; member_level integer; used_today integer;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  insert into public.member_progression(member_slug, total_xp, level) values (me, 0, 1)
    on conflict (member_slug) do nothing;
  select total_xp, level into total, member_level from public.member_progression where member_slug = me;
  select coalesce(sum(xp_amount), 0) into used_today from public.xp_transactions
    where member_slug = me and source_type = 'match' and created_at::date = current_date;
  return jsonb_build_object('totalXp', total, 'level', member_level, 'xpToday', used_today, 'dailyCap', 100);
end;
$$;

notify pgrst, 'reload schema';
