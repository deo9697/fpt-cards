-- F.P.T Cards - eseguire una sola volta nel SQL Editor di Supabase.

create table if not exists public.team_members (
  slug text primary key,
  full_name text not null,
  user_id uuid unique references auth.users(id) on delete set null
);

insert into public.team_members (slug, full_name) values
  ('daniele', 'Daniele de Oliveira'),
  ('cristian-arlia', 'Cristian Arlia'),
  ('cristian-spadafora', 'Cristian Spadafora'),
  ('cristofer', 'Cristofer Marincolo')
on conflict (slug) do update set full_name = excluded.full_name;

create table if not exists public.loans (
  id uuid primary key default gen_random_uuid(),
  card_name text not null check (char_length(card_name) between 1 and 200),
  quantity integer not null check (quantity between 1 and 99),
  owner_slug text not null references public.team_members(slug),
  borrower_slug text not null references public.team_members(slug),
  notes text not null default '' check (char_length(notes) <= 500),
  status text not null default 'pending' check (status in ('pending','active','return_pending','returned')),
  created_at timestamptz not null default now(),
  returned_at timestamptz,
  check (owner_slug <> borrower_slug)
);

alter table public.team_members enable row level security;
alter table public.loans enable row level security;

create or replace function public.claim_team_member()
returns trigger language plpgsql security definer set search_path = public as $$
declare requested_slug text;
begin
  requested_slug := split_part(new.email, '@', 1);
  update public.team_members set user_id = new.id
    where slug = requested_slug and user_id is null;
  if not found then raise exception 'Profilo del team non disponibile'; end if;
  return new;
end;
$$;

drop trigger if exists claim_fpt_member on auth.users;
create trigger claim_fpt_member after insert on auth.users
for each row execute function public.claim_team_member();

create or replace function public.my_team_slug()
returns text language sql stable security definer set search_path = public as $$
  select slug from public.team_members where user_id = auth.uid()
$$;

create or replace function public.transition_loan(p_id uuid, p_action text)
returns void language plpgsql security definer set search_path = public as $$
declare item public.loans; me text := public.my_team_slug();
begin
  select * into item from public.loans where id = p_id for update;
  if not found then raise exception 'Prestito non trovato'; end if;
  if p_action = 'accept' and item.status = 'pending' and item.borrower_slug = me then
    update public.loans set status = 'active' where id = p_id;
  elsif p_action = 'reject' and item.status = 'pending' and item.borrower_slug = me then
    delete from public.loans where id = p_id;
  elsif p_action = 'return' and item.status = 'active' and item.borrower_slug = me then
    update public.loans set status = 'return_pending' where id = p_id;
  elsif p_action = 'confirm-return' and item.status = 'return_pending' and item.owner_slug = me then
    update public.loans set status = 'returned', returned_at = now() where id = p_id;
  else
    raise exception 'Operazione non consentita';
  end if;
end;
$$;

drop policy if exists "team members visible" on public.team_members;
create policy "team members visible" on public.team_members for select to authenticated using (true);
drop policy if exists "involved loans visible" on public.loans;
create policy "involved loans visible" on public.loans for select to authenticated
using (owner_slug = public.my_team_slug() or borrower_slug = public.my_team_slug());
drop policy if exists "owners create loans" on public.loans;
create policy "owners create loans" on public.loans for insert to authenticated
with check (owner_slug = public.my_team_slug() and status = 'pending');

revoke all on public.team_members, public.loans from anon;
grant select on public.team_members to authenticated;
grant select, insert on public.loans to authenticated;
revoke all on function public.transition_loan(uuid, text) from public, anon;
grant execute on function public.transition_loan(uuid, text) to authenticated;
