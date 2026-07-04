-- Eseguire una sola volta dopo supabase-setup.sql.
alter table public.team_members add column if not exists role text not null default 'guest'
  check (role in ('admin', 'guest'));
update public.team_members set role = 'guest';
update public.team_members set role = 'admin' where slug = 'daniele';

create or replace function public.is_member_claimed(p_slug text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.team_members where slug = p_slug and user_id is not null)
$$;
revoke all on function public.is_member_claimed(text) from public;
grant execute on function public.is_member_claimed(text) to anon, authenticated;

create or replace function public.is_team_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.team_members where user_id = auth.uid() and role = 'admin')
$$;

drop policy if exists "involved loans visible" on public.loans;
create policy "involved loans visible" on public.loans for select to authenticated
using (public.is_team_admin() or owner_slug = public.my_team_slug() or borrower_slug = public.my_team_slug());

create or replace function public.transition_loan(p_id uuid, p_action text)
returns void language plpgsql security definer set search_path = public as $$
declare item public.loans; me text := public.my_team_slug(); admin boolean := public.is_team_admin();
begin
  select * into item from public.loans where id = p_id for update;
  if not found then raise exception 'Prestito non trovato'; end if;
  if p_action = 'admin-delete' and admin then
    delete from public.loans where id = p_id;
  elsif p_action = 'accept' and item.status = 'pending' and (item.borrower_slug = me or admin) then
    update public.loans set status = 'active' where id = p_id;
  elsif p_action = 'reject' and item.status = 'pending' and (item.borrower_slug = me or admin) then
    delete from public.loans where id = p_id;
  elsif p_action = 'return' and item.status = 'active' and (item.borrower_slug = me or admin) then
    update public.loans set status = 'return_pending' where id = p_id;
  elsif p_action = 'confirm-return' and item.status = 'return_pending' and (item.owner_slug = me or admin) then
    update public.loans set status = 'returned', returned_at = now() where id = p_id;
  else raise exception 'Operazione non consentita';
  end if;
end;
$$;
