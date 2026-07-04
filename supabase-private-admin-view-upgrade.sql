-- Anche l'amministratore vede solo i prestiti che lo coinvolgono.
create or replace function public.list_team_loans(p_token text)
returns setof public.loans language plpgsql security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token);
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  return query
    select l.* from public.loans l
    where l.owner_slug = me or l.borrower_slug = me
    order by l.created_at;
end;
$$;

revoke all on function public.list_team_loans(text) from public;
grant execute on function public.list_team_loans(text) to anon, authenticated;
