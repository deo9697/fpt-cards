-- PIN globale e sessioni applicative per F.P.T Cards.
-- Eseguire una sola volta nel SQL Editor di Supabase.

create extension if not exists pgcrypto with schema extensions;

alter table public.team_members add column if not exists role text not null default 'guest';
alter table public.team_members add column if not exists pin_hash text;
update public.team_members set role = case when slug = 'daniele' then 'admin' else 'guest' end;

create table if not exists public.app_sessions (
  token_hash bytea primary key,
  member_slug text not null references public.team_members(slug) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
alter table public.app_sessions enable row level security;

-- Chiude ogni accesso diretto: il browser usa esclusivamente le funzioni controllate.
revoke all on public.team_members, public.loans, public.app_sessions from anon, authenticated;
drop policy if exists "team app reads loans" on public.loans;
drop policy if exists "team app creates loans" on public.loans;
drop policy if exists "involved loans visible" on public.loans;
drop policy if exists "owners create loans" on public.loans;

create or replace function public.session_member(p_token text)
returns text language sql stable security definer set search_path = public, extensions as $$
  select member_slug from public.app_sessions
  where token_hash = digest(p_token, 'sha256') and expires_at > now()
$$;
revoke all on function public.session_member(text) from public, anon, authenticated;

create or replace function public.login_member(p_slug text, p_pin text, p_token text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare item public.team_members;
begin
  if p_pin !~ '^[0-9]{4}$' or char_length(p_token) < 32 then raise exception 'Dati di accesso non validi'; end if;
  select * into item from public.team_members where slug = p_slug for update;
  if not found then raise exception 'Profilo non trovato'; end if;
  if item.pin_hash is null then
    update public.team_members set pin_hash = crypt(p_pin, gen_salt('bf', 10)) where slug = p_slug;
  elsif item.pin_hash <> crypt(p_pin, item.pin_hash) then
    raise exception 'PIN non corretto';
  end if;
  delete from public.app_sessions where expires_at <= now();
  insert into public.app_sessions(token_hash, member_slug, expires_at)
  values (digest(p_token, 'sha256'), p_slug, now() + interval '30 days')
  on conflict (token_hash) do update set member_slug = excluded.member_slug, expires_at = excluded.expires_at;
  return jsonb_build_object('slug', item.slug, 'name', item.full_name, 'role', item.role);
end;
$$;

create or replace function public.logout_member(p_token text)
returns void language sql security definer set search_path = public, extensions as $$
  delete from public.app_sessions where token_hash = digest(p_token, 'sha256')
$$;

create or replace function public.list_team_loans(p_token text)
returns setof public.loans language plpgsql security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token); admin boolean;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  select role = 'admin' into admin from public.team_members where slug = me;
  return query select l.* from public.loans l
    where admin or l.owner_slug = me or l.borrower_slug = me order by l.created_at;
end;
$$;

create or replace function public.create_team_loan(
  p_token text, p_card_name text, p_quantity integer, p_borrower_slug text, p_notes text default ''
) returns public.loans language plpgsql security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token); result public.loans;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  if p_card_name is null or char_length(trim(p_card_name)) not between 1 and 200 then raise exception 'Nome carta non valido'; end if;
  if p_quantity not between 1 and 99 or p_borrower_slug = me then raise exception 'Prestito non valido'; end if;
  insert into public.loans(card_name, quantity, owner_slug, borrower_slug, notes)
  values(trim(p_card_name), p_quantity, me, p_borrower_slug, left(coalesce(p_notes,''),500)) returning * into result;
  return result;
end;
$$;

drop function if exists public.transition_loan(uuid, text, text);
create or replace function public.transition_loan(p_token text, p_id uuid, p_action text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare item public.loans; me text := public.session_member(p_token); admin boolean;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  select role = 'admin' into admin from public.team_members where slug = me;
  select * into item from public.loans where id = p_id for update;
  if not found then raise exception 'Prestito non trovato'; end if;
  if p_action = 'admin-delete' and admin then delete from public.loans where id = p_id;
  elsif p_action = 'accept' and item.status = 'pending' and (item.borrower_slug = me or admin) then update public.loans set status='active' where id=p_id;
  elsif p_action = 'reject' and item.status = 'pending' and (item.borrower_slug = me or admin) then delete from public.loans where id=p_id;
  elsif p_action = 'return' and item.status = 'active' and (item.borrower_slug = me or admin) then update public.loans set status='return_pending' where id=p_id;
  elsif p_action = 'confirm-return' and item.status = 'return_pending' and (item.owner_slug = me or admin) then update public.loans set status='returned', returned_at=now() where id=p_id;
  else raise exception 'Operazione non consentita'; end if;
end;
$$;

revoke all on function public.login_member(text,text,text), public.logout_member(text),
  public.list_team_loans(text), public.create_team_loan(text,text,integer,text,text),
  public.transition_loan(text,uuid,text) from public;
grant execute on function public.login_member(text,text,text), public.logout_member(text),
  public.list_team_loans(text), public.create_team_loan(text,text,integer,text,text),
  public.transition_loan(text,uuid,text) to anon, authenticated;
