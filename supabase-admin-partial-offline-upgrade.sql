-- Gestione membri admin e restituzioni parziali.
-- Eseguire dopo supabase-multi-game-upgrade.sql.

alter table public.team_members add column if not exists active boolean not null default true;
alter table public.loans add column if not exists returned_quantity integer not null default 0;
alter table public.loans add column if not exists pending_return_quantity integer not null default 0;

update public.loans set returned_quantity = quantity where status = 'returned';
update public.loans set pending_return_quantity = quantity where status = 'return_pending' and pending_return_quantity = 0;

alter table public.loans drop constraint if exists loans_returned_quantity_check;
alter table public.loans add constraint loans_returned_quantity_check
  check (returned_quantity between 0 and quantity);
alter table public.loans drop constraint if exists loans_pending_return_quantity_check;
alter table public.loans add constraint loans_pending_return_quantity_check
  check (pending_return_quantity between 0 and quantity - returned_quantity);

create or replace function public.list_login_members()
returns table(slug text, full_name text, role text)
language sql stable security definer set search_path = public as $$
  select m.slug, m.full_name, m.role from public.team_members m
  where m.active order by (m.role = 'admin') desc, m.full_name
$$;
revoke all on function public.list_login_members() from public;
grant execute on function public.list_login_members() to anon, authenticated;

create or replace function public.login_member(p_slug text, p_pin text, p_token text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare item public.team_members;
begin
  if p_pin !~ '^[0-9]{4}$' or char_length(p_token) < 32 then raise exception 'Dati di accesso non validi'; end if;
  select * into item from public.team_members where slug = p_slug and active for update;
  if not found then raise exception 'Profilo non trovato o disattivato'; end if;
  if item.pin_hash is null then
    update public.team_members set pin_hash = crypt(p_pin, gen_salt('bf', 10)) where slug = p_slug;
  elsif item.pin_hash <> crypt(p_pin, item.pin_hash) then raise exception 'PIN non corretto';
  end if;
  delete from public.app_sessions where expires_at <= now();
  insert into public.app_sessions(token_hash, member_slug, expires_at)
  values (digest(p_token, 'sha256'), p_slug, now() + interval '30 days')
  on conflict (token_hash) do update set member_slug = excluded.member_slug, expires_at = excluded.expires_at;
  return jsonb_build_object('slug', item.slug, 'name', item.full_name, 'role', item.role);
end;
$$;

create or replace function public.admin_manage_member(
  p_token text, p_action text, p_slug text, p_name text default null
) returns void language plpgsql security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token); admin boolean;
begin
  select role = 'admin' into admin from public.team_members where slug = me and active;
  if me is null or not coalesce(admin,false) then raise exception 'Solo l’amministratore può gestire i membri'; end if;
  if p_action = 'add' then
    if p_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or char_length(trim(coalesce(p_name,''))) not between 2 and 100 then raise exception 'Dati membro non validi'; end if;
    insert into public.team_members(slug, full_name, role, active)
      values(p_slug, trim(p_name), 'guest', true)
      on conflict (slug) do update set full_name = excluded.full_name, active = true, pin_hash = null;
  elsif p_action = 'reset-pin' then
    update public.team_members set pin_hash = null where slug = p_slug and role <> 'admin';
    delete from public.app_sessions where member_slug = p_slug;
  elsif p_action = 'deactivate' then
    if p_slug = me then raise exception 'Non puoi disattivare il tuo profilo'; end if;
    update public.team_members set active = false where slug = p_slug and role <> 'admin';
    delete from public.app_sessions where member_slug = p_slug;
  else raise exception 'Azione non valida';
  end if;
end;
$$;
revoke all on function public.admin_manage_member(text,text,text,text) from public;
grant execute on function public.admin_manage_member(text,text,text,text) to anon, authenticated;

create or replace function public.return_loan_quantity(p_token text, p_id uuid, p_quantity integer)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare item public.loans; me text := public.session_member(p_token);
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  select * into item from public.loans where id = p_id for update;
  if not found or item.borrower_slug <> me or item.status <> 'active' then raise exception 'Operazione non consentita'; end if;
  if p_quantity < 1 or p_quantity > item.quantity - item.returned_quantity then raise exception 'Quantità non valida'; end if;
  update public.loans set status = 'return_pending', pending_return_quantity = p_quantity where id = p_id;
end;
$$;
revoke all on function public.return_loan_quantity(text,uuid,integer) from public;
grant execute on function public.return_loan_quantity(text,uuid,integer) to anon, authenticated;

create or replace function public.transition_loan(p_token text, p_id uuid, p_action text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare item public.loans; me text := public.session_member(p_token); admin boolean; new_returned integer;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  select role = 'admin' into admin from public.team_members where slug = me;
  select * into item from public.loans where id = p_id for update;
  if not found then raise exception 'Prestito non trovato'; end if;
  if p_action = 'admin-delete' and admin then delete from public.loans where id = p_id;
  elsif p_action = 'accept' and item.status = 'pending' and item.borrower_slug = me then update public.loans set status='active' where id=p_id;
  elsif p_action = 'reject' and item.status = 'pending' and item.borrower_slug = me then delete from public.loans where id=p_id;
  elsif p_action = 'return' and item.status = 'active' and item.borrower_slug = me then
    update public.loans set status='return_pending', pending_return_quantity=quantity-returned_quantity where id=p_id;
  elsif p_action = 'confirm-return' and item.status = 'return_pending' and item.owner_slug = me then
    new_returned := item.returned_quantity + item.pending_return_quantity;
    update public.loans set returned_quantity = new_returned, pending_return_quantity = 0,
      status = case when new_returned >= quantity then 'returned' else 'active' end,
      returned_at = case when new_returned >= quantity then now() else null end where id=p_id;
  else raise exception 'Operazione non consentita'; end if;
end;
$$;
revoke all on function public.transition_loan(text,uuid,text) from public;
grant execute on function public.transition_loan(text,uuid,text) to anon, authenticated;

notify pgrst, 'reload schema';
