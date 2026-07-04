-- F.P.T Cards senza registrazione email.
-- Eseguire nel SQL Editor dopo gli altri script.

drop policy if exists "involved loans visible" on public.loans;
drop policy if exists "owners create loans" on public.loans;

create policy "team app reads loans" on public.loans
for select to anon, authenticated using (true);

create policy "team app creates loans" on public.loans
for insert to anon, authenticated
with check (status = 'pending' and owner_slug <> borrower_slug);

grant select on public.team_members to anon, authenticated;
grant select, insert on public.loans to anon, authenticated;

create or replace function public.transition_loan(p_id uuid, p_action text, p_actor_slug text)
returns void language plpgsql security definer set search_path = public as $$
declare
  item public.loans;
  admin boolean := p_actor_slug = 'daniele';
begin
  if not exists(select 1 from public.team_members where slug = p_actor_slug) then
    raise exception 'Membro non valido';
  end if;
  select * into item from public.loans where id = p_id for update;
  if not found then raise exception 'Prestito non trovato'; end if;

  if p_action = 'admin-delete' and admin then
    delete from public.loans where id = p_id;
  elsif p_action = 'accept' and item.status = 'pending' and (item.borrower_slug = p_actor_slug or admin) then
    update public.loans set status = 'active' where id = p_id;
  elsif p_action = 'reject' and item.status = 'pending' and (item.borrower_slug = p_actor_slug or admin) then
    delete from public.loans where id = p_id;
  elsif p_action = 'return' and item.status = 'active' and (item.borrower_slug = p_actor_slug or admin) then
    update public.loans set status = 'return_pending' where id = p_id;
  elsif p_action = 'confirm-return' and item.status = 'return_pending' and (item.owner_slug = p_actor_slug or admin) then
    update public.loans set status = 'returned', returned_at = now() where id = p_id;
  else
    raise exception 'Operazione non consentita';
  end if;
end;
$$;

revoke execute on function public.transition_loan(uuid, text) from public, anon, authenticated;
grant execute on function public.transition_loan(uuid, text, text) to anon, authenticated;
