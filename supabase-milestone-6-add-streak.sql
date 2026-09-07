-- F.P.T Cards — Statistiche: aggiunge get_match_streak per il redesign
-- "Duello" della pagina Statistiche (striscia di vittorie/sconfitte
-- consecutive più recente, per gioco). Additiva, eseguire dopo
-- supabase-milestone-6-statistics-progression.sql (e il fix
-- supabase-milestone-6-fix-ambiguous-level.sql).
--
-- Tecnica "gaps and islands": numera i match dal più recente (rn),
-- raggruppa le righe consecutive con lo stesso risultato (grp = rn -
-- row_number partizionato per risultato), poi conta quante righe del
-- gruppo del match più recente condividono lo stesso risultato e lo
-- stesso grp — cioè la lunghezza della serie corrente.

create or replace function public.get_match_streak(p_token text, p_game text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token); streak_result text; streak_count integer;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  with ordered as (
    select result, row_number() over (order by played_at desc, created_at desc) as rn
    from public.matches where member_slug = me and game = p_game
  ), grp as (
    select result, rn, rn - row_number() over (partition by result order by rn) as grp
    from ordered
  )
  select g.result, count(*) into streak_result, streak_count
  from grp g, (select result, grp from grp where rn = 1) top
  where g.result = top.result and g.grp = top.grp
  group by g.result;

  if streak_result is null then return jsonb_build_object('result', null, 'count', 0); end if;
  return jsonb_build_object('result', streak_result, 'count', streak_count);
end;
$$;

revoke all on function public.get_match_streak(text,text) from public, anon, authenticated;
grant execute on function public.get_match_streak(text,text) to anon, authenticated;

notify pgrst, 'reload schema';
