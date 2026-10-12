-- F.P.T Cards — Beta per utenti esterni: team separati, inviti e realtime per team.
--
-- Cosa fa:
--   1. Tabella `teams` (F.P.T. = team `core`, i team della beta = `beta`) e
--      `team_members.team_id`. Tutti i membri esistenti finiscono nel team core.
--   2. `team_invites` + `beta_settings`: link di invito (nuovo team o team
--      esistente), limite di iscritti, interruttore iscrizioni aperte/chiuse.
--   3. Isolamento: le RPC "di team" che oggi leggono i dati di tutti i membri
--      vengono filtrate sul team di chi chiama. Prestiti e sfide tra team
--      diversi vengono bloccati da trigger sulle tabelle.
--   4. Realtime per team: i broadcast di raccolta/prestiti vanno sul canale
--      `fpt-collection:<team_id>` / `fpt-loans:<team_id>`, con l'elenco dei
--      membri che hanno modificato la raccolta, così il client ricarica solo
--      quello che serve. Il team core riceve anche i canali storici finché i
--      client vecchi non si aggiornano.
--
-- Drift: il database live contiene versioni di alcune funzioni diverse dal
-- repository. Per non sovrascriverle, le RPC esistenti NON vengono riscritte
-- per intero: la migration legge la definizione live (pg_get_functiondef),
-- applica una sostituzione mirata e verifica il numero di occorrenze. Se una
-- funzione live non corrisponde al pattern atteso, l'intera migration va in
-- rollback con un messaggio che indica quale funzione controllare.
-- È idempotente: rieseguirla non applica due volte i filtri.

begin;

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- 1. Team
-- ---------------------------------------------------------------------------

create table if not exists public.teams (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 2 and 40),
  kind text not null default 'beta' check (kind in ('core', 'beta')),
  owner_slug text references public.team_members(slug) on delete set null,
  created_at timestamptz not null default now()
);
create unique index if not exists teams_single_core_idx on public.teams(kind) where kind = 'core';
alter table public.teams enable row level security;

insert into public.teams(name, kind)
select 'F.P.T.', 'core'
where not exists (select 1 from public.teams where kind = 'core');

create or replace function public.core_team_id()
returns uuid language sql stable security definer set search_path = public as $$
  select id from public.teams where kind = 'core'
$$;

alter table public.team_members add column if not exists team_id uuid references public.teams(id);
update public.team_members set team_id = public.core_team_id() where team_id is null;
alter table public.team_members alter column team_id set not null;
create index if not exists team_members_team_idx on public.team_members(team_id) where active;

-- I membri creati dall'admin (admin_manage_member 'add') non passano un team:
-- finiscono nel team core come oggi.
create or replace function public.team_members_default_team()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.team_id is null then new.team_id := public.core_team_id(); end if;
  return new;
end;
$$;
drop trigger if exists team_members_default_team on public.team_members;
create trigger team_members_default_team before insert on public.team_members
for each row execute function public.team_members_default_team();

create or replace function public.member_team(p_slug text)
returns uuid language sql stable security definer set search_path = public as $$
  select team_id from public.team_members where slug = p_slug
$$;

-- ---------------------------------------------------------------------------
-- 2. Inviti e impostazioni beta
-- ---------------------------------------------------------------------------

create table if not exists public.beta_settings (
  id boolean primary key default true check (id),
  signups_open boolean not null default true,
  max_beta_members integer not null default 30 check (max_beta_members between 0 and 1000),
  max_team_members integer not null default 12 check (max_team_members between 1 and 100),
  updated_at timestamptz not null default now()
);
insert into public.beta_settings(id) values (true) on conflict (id) do nothing;
alter table public.beta_settings enable row level security;

create table if not exists public.team_invites (
  code text primary key check (code ~ '^[A-F0-9]{16}$'),
  team_id uuid references public.teams(id) on delete cascade, -- null = chi entra crea il proprio team
  created_by text not null references public.team_members(slug) on delete cascade,
  max_uses integer not null check (max_uses between 1 and 100),
  uses integer not null default 0 check (uses >= 0),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists team_invites_creator_idx on public.team_invites(created_by, created_at desc);
create index if not exists team_invites_team_idx on public.team_invites(team_id, created_at desc);
alter table public.team_invites enable row level security;

revoke all on public.teams, public.beta_settings, public.team_invites from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. RPC nuove
-- ---------------------------------------------------------------------------

create or replace function public.get_my_team(p_token text)
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token); my public.team_members; team public.teams;
  settings public.beta_settings; admin boolean; beta_count integer; result jsonb;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  select * into my from public.team_members where slug = me;
  select * into team from public.teams where id = my.team_id;
  admin := my.role = 'admin';
  result := jsonb_build_object(
    'id', team.id, 'name', team.name, 'kind', team.kind,
    'isOwner', coalesce(team.owner_slug = me, false),
    'memberCount', (select count(*) from public.team_members where team_id = team.id and active),
    'canInviteToTeam', (team.kind = 'beta' and team.owner_slug = me) or admin,
    'canInviteNewTeam', admin
  );
  if admin then
    select * into settings from public.beta_settings where id;
    select count(*) into beta_count from public.team_members m join public.teams t on t.id = m.team_id
      where t.kind = 'beta' and m.active;
    result := result || jsonb_build_object('beta', jsonb_build_object(
      'signupsOpen', settings.signups_open, 'members', beta_count,
      'maxMembers', settings.max_beta_members, 'maxTeamMembers', settings.max_team_members,
      'teams', (select count(*) from public.teams where kind = 'beta')));
  end if;
  return result;
end;
$$;

create or replace function public.list_team_members(p_token text)
returns table(slug text, full_name text, role text)
language plpgsql stable security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token);
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  return query select m.slug, m.full_name, m.role from public.team_members m
    where m.active and m.team_id = public.member_team(me)
    order by (m.role = 'admin') desc, m.full_name;
end;
$$;

create or replace function public.create_team_invite(
  p_token text, p_mode text default 'my_team', p_max_uses integer default 10, p_days integer default 14
) returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token); my public.team_members; team public.teams;
  target uuid; new_code text;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  if p_mode not in ('my_team', 'new_team') then raise exception 'Tipo di invito non valido'; end if;
  if p_max_uses not between 1 and 100 or p_days not between 1 and 90 then raise exception 'Limiti dell''invito non validi'; end if;
  select * into my from public.team_members where slug = me and active;
  select * into team from public.teams where id = my.team_id;
  if p_mode = 'new_team' then
    if my.role <> 'admin' then raise exception 'Solo l''amministratore può creare link per nuovi team'; end if;
    target := null;
  else
    if not (my.role = 'admin' or (team.kind = 'beta' and team.owner_slug = me)) then
      raise exception 'Solo il creatore del team può invitare nuovi membri';
    end if;
    target := team.id;
  end if;
  if (select count(*) from public.team_invites where created_by = me and revoked_at is null
      and expires_at > now() and uses < max_uses) >= 20 then
    raise exception 'Hai già troppi inviti attivi: revocane qualcuno';
  end if;
  new_code := upper(encode(gen_random_bytes(8), 'hex'));
  insert into public.team_invites(code, team_id, created_by, max_uses, expires_at)
    values (new_code, target, me, p_max_uses, now() + make_interval(days => p_days));
  return jsonb_build_object('code', new_code, 'mode', p_mode, 'maxUses', p_max_uses,
    'expiresAt', now() + make_interval(days => p_days));
end;
$$;

create or replace function public.list_team_invites(p_token text)
returns table(code text, mode text, team_name text, uses integer, max_uses integer,
  expires_at timestamptz, revoked boolean, created_at timestamptz)
language plpgsql stable security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token); my public.team_members;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  select * into my from public.team_members where slug = me;
  return query select i.code, case when i.team_id is null then 'new_team' else 'my_team' end,
      t.name, i.uses, i.max_uses, i.expires_at, i.revoked_at is not null, i.created_at
    from public.team_invites i left join public.teams t on t.id = i.team_id
    where i.created_by = me
       or (i.team_id = my.team_id and exists(select 1 from public.teams o where o.id = my.team_id and o.owner_slug = me))
    order by i.created_at desc
    limit 50;
end;
$$;

create or replace function public.revoke_team_invite(p_token text, p_code text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token);
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  update public.team_invites i set revoked_at = coalesce(i.revoked_at, now())
    where i.code = upper(trim(p_code)) and (i.created_by = me
      or exists(select 1 from public.teams t where t.id = i.team_id and t.owner_slug = me));
  if not found then raise exception 'Invito non trovato'; end if;
end;
$$;

create or replace function public.rename_my_team(p_token text, p_name text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token); clean text := regexp_replace(trim(coalesce(p_name, '')), '\s+', ' ', 'g');
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  if char_length(clean) not between 2 and 40 then raise exception 'Il nome del team deve avere tra 2 e 40 caratteri'; end if;
  update public.teams set name = clean where id = public.member_team(me) and kind = 'beta' and owner_slug = me;
  if not found then raise exception 'Solo il creatore del team può rinominarlo'; end if;
end;
$$;

create or replace function public.set_beta_signups(p_token text, p_open boolean)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token);
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  if not exists(select 1 from public.team_members where slug = me and role = 'admin' and active) then
    raise exception 'Solo l''amministratore può gestire la beta';
  end if;
  update public.beta_settings set signups_open = coalesce(p_open, false), updated_at = now() where id;
end;
$$;

-- Pubblica: serve alla pagina "crea il tuo profilo" prima del login.
-- Non espone nomi dei membri, solo il nome del team di destinazione.
create or replace function public.get_invite_info(p_code text)
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare inv public.team_invites; settings public.beta_settings; team_name text;
begin
  select * into settings from public.beta_settings where id;
  select * into inv from public.team_invites where code = upper(trim(coalesce(p_code, '')));
  if not found or inv.revoked_at is not null or inv.expires_at <= now() or inv.uses >= inv.max_uses then
    return jsonb_build_object('valid', false, 'reason', 'Questo invito non è valido o è scaduto.');
  end if;
  if not settings.signups_open then
    return jsonb_build_object('valid', false, 'reason', 'Le iscrizioni alla beta sono momentaneamente chiuse.');
  end if;
  select name into team_name from public.teams where id = inv.team_id;
  return jsonb_build_object('valid', true,
    'mode', case when inv.team_id is null then 'new_team' else 'join_team' end,
    'teamName', team_name);
end;
$$;

create or replace function public.register_with_invite(
  p_code text, p_name text, p_pin text, p_team_name text, p_token text
) returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare inv public.team_invites; settings public.beta_settings; target public.teams;
  clean_name text := regexp_replace(trim(coalesce(p_name, '')), '\s+', ' ', 'g');
  clean_team text := regexp_replace(trim(coalesce(p_team_name, '')), '\s+', ' ', 'g');
  base text; new_slug text;
begin
  if coalesce(p_pin, '') !~ '^[0-9]{4}$' or char_length(coalesce(p_token, '')) < 32 then
    raise exception 'Dati di accesso non validi';
  end if;
  if char_length(clean_name) not between 2 and 60 then raise exception 'Il nome deve avere tra 2 e 60 caratteri'; end if;
  select * into settings from public.beta_settings where id;
  if not settings.signups_open then raise exception 'Le iscrizioni alla beta sono momentaneamente chiuse'; end if;
  select * into inv from public.team_invites where code = upper(trim(coalesce(p_code, ''))) for update;
  if not found or inv.revoked_at is not null or inv.expires_at <= now() or inv.uses >= inv.max_uses then
    raise exception 'Questo invito non è valido o è scaduto';
  end if;

  if inv.team_id is null then
    if char_length(clean_team) not between 2 and 40 then raise exception 'Il nome del team deve avere tra 2 e 40 caratteri'; end if;
  else
    select * into target from public.teams where id = inv.team_id;
    if (select count(*) from public.team_members where team_id = target.id and active) >= settings.max_team_members then
      raise exception 'Questo team è al completo';
    end if;
  end if;
  if (inv.team_id is null or target.kind = 'beta') and (
    select count(*) from public.team_members m join public.teams t on t.id = m.team_id
    where t.kind = 'beta' and m.active) >= settings.max_beta_members then
    raise exception 'La beta è al completo, riprova più avanti';
  end if;

  -- Nome utente: nome normalizzato + suffisso casuale, così non coincide mai
  -- con i profili esistenti e non si può indovinare.
  base := translate(lower(clean_name), 'àáâãäåèéêëìíîïòóôõöùúûüñç', 'aaaaaaeeeeiiiiooooouuuunc');
  base := trim(both '-' from regexp_replace(base, '[^a-z0-9]+', '-', 'g'));
  base := trim(both '-' from left(base, 30));
  if base = '' then base := 'giocatore'; end if;
  loop
    new_slug := base || '-' || substr(encode(gen_random_bytes(3), 'hex'), 1, 4);
    exit when not exists(select 1 from public.team_members where slug = new_slug);
  end loop;

  if inv.team_id is null then
    insert into public.teams(name, kind) values (clean_team, 'beta') returning * into target;
  end if;
  insert into public.team_members(slug, full_name, role, active, pin_hash, team_id)
    values (new_slug, clean_name, 'guest', true, crypt(p_pin, gen_salt('bf', 10)), target.id);
  if inv.team_id is null then update public.teams set owner_slug = new_slug where id = target.id; end if;
  insert into public.member_progression(member_slug) values (new_slug) on conflict do nothing;
  update public.team_invites set uses = uses + 1 where code = inv.code;

  insert into public.app_sessions(token_hash, member_slug, expires_at)
    values (digest(p_token, 'sha256'), new_slug, now() + interval '30 days')
    on conflict (token_hash) do update set member_slug = excluded.member_slug, expires_at = excluded.expires_at;
  return jsonb_build_object('slug', new_slug, 'name', clean_name, 'role', 'guest',
    'canVerifyYgoArtwork', false, 'teamId', target.id, 'teamName', target.name);
end;
$$;

revoke all on function public.core_team_id(), public.member_team(text),
  public.team_members_default_team() from public, anon, authenticated;
revoke all on function public.get_my_team(text), public.list_team_members(text),
  public.create_team_invite(text, text, integer, integer), public.list_team_invites(text),
  public.revoke_team_invite(text, text), public.rename_my_team(text, text),
  public.set_beta_signups(text, boolean), public.get_invite_info(text),
  public.register_with_invite(text, text, text, text, text) from public;
grant execute on function public.get_my_team(text), public.list_team_members(text),
  public.create_team_invite(text, text, integer, integer), public.list_team_invites(text),
  public.revoke_team_invite(text, text), public.rename_my_team(text, text),
  public.set_beta_signups(text, boolean), public.get_invite_info(text),
  public.register_with_invite(text, text, text, text, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Isolamento delle RPC esistenti (patch mirate sulle definizioni live)
-- ---------------------------------------------------------------------------

create or replace function pg_temp.fpt_patch_function(
  p_fn regprocedure, p_pattern text, p_replacement text, p_expected integer
) returns void language plpgsql as $$
declare def text := pg_get_functiondef(p_fn); hits integer;
begin
  if def ~ '(member_team|core_team_id)\(' then
    raise notice 'Beta teams: % già filtrata, salto', p_fn;
    return;
  end if;
  select count(*) into hits from regexp_matches(def, p_pattern, 'gi');
  if hits <> p_expected then
    raise exception 'Beta teams: % contiene % occorrenze del pattern atteso (attese %). La versione live è diversa dal repository: aggiornare questa migration prima di applicarla.',
      p_fn, hits, p_expected;
  end if;
  execute regexp_replace(def, p_pattern, p_replacement, 'gi');
end;
$$;

-- `join public.team_members X on X.slug = <colonna> and X.active` → stesso team di chi chiama.
select pg_temp.fpt_patch_function(fn::regprocedure,
  'join\s+public\.team_members\s+(\w+)\s+on\s+\1\.slug\s*=\s*(\w+\.\w+)\s+and\s+\1\.active',
  'join public.team_members \1 on \1.slug = \2 and \1.active and \1.team_id = public.member_team(me)',
  expected)
from (values
  ('public.list_member_profiles(text)', 1),
  ('public.list_member_avatars(text)', 1),
  ('public.list_team_collection(text)', 1),
  ('public.list_team_decks(text)', 1),
  ('public.get_team_stats(text, text, text)', 1),
  ('public.get_head_to_head(text, text, text)', 2)
) as targets(fn, expected);

-- L'admin vedeva i prestiti di tutti: ora solo quelli del proprio team.
select pg_temp.fpt_patch_function('public.list_team_loans(text)'::regprocedure,
  'where\s+admin\s+or\s+l\.owner_slug',
  'where (admin and public.member_team(l.owner_slug) = public.member_team(me)) or l.owner_slug',
  1);

-- La schermata di login (pubblica) elenca solo il team F.P.T.;
-- i profili beta entrano con il nome utente.
select pg_temp.fpt_patch_function('public.list_login_members()'::regprocedure,
  'where\s+m\.active\s',
  'where m.active and m.team_id = public.core_team_id() ',
  1);

-- Prestiti e sfide solo dentro lo stesso team, qualunque RPC li crei.
create or replace function public.enforce_loan_same_team()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if public.member_team(new.owner_slug) is distinct from public.member_team(new.borrower_slug) then
    raise exception 'Puoi scambiare carte solo con i membri del tuo team';
  end if;
  return new;
end;
$$;
drop trigger if exists loans_same_team on public.loans;
create trigger loans_same_team before insert or update of owner_slug, borrower_slug on public.loans
for each row execute function public.enforce_loan_same_team();

create or replace function public.enforce_match_same_team()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.opponent_member_slug is not null
     and public.member_team(new.member_slug) is distinct from public.member_team(new.opponent_member_slug) then
    raise exception 'Puoi registrare sfide solo contro i membri del tuo team';
  end if;
  return new;
end;
$$;
drop trigger if exists matches_same_team on public.matches;
create trigger matches_same_team before insert or update of member_slug, opponent_member_slug on public.matches
for each row execute function public.enforce_match_same_team();

revoke all on function public.enforce_loan_same_team(), public.enforce_match_same_team() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Realtime per team
-- ---------------------------------------------------------------------------

-- Raccolta: un broadcast per team a fine statement, con i membri coinvolti.
-- Le transition table richiedono un trigger per evento, quindi tre funzioni.
create or replace function public.broadcast_collection_insert()
returns trigger language plpgsql security definer set search_path = public, realtime as $$
declare item record;
begin
  for item in
    select m.team_id, jsonb_agg(distinct m.slug) members, bool_or(t.kind = 'core') core
    from (select distinct owner_slug from new_rows) c
    join public.team_members m on m.slug = c.owner_slug join public.teams t on t.id = m.team_id
    group by m.team_id
  loop
    perform realtime.send(jsonb_build_object('changed', true, 'members', item.members),
      'collection_changed', 'fpt-collection:' || item.team_id, false);
    if item.core then perform realtime.send(jsonb_build_object('changed', true), 'collection_changed', 'fpt-collection', false); end if;
  end loop;
  return null;
end;
$$;

create or replace function public.broadcast_collection_update()
returns trigger language plpgsql security definer set search_path = public, realtime as $$
declare item record;
begin
  for item in
    select m.team_id, jsonb_agg(distinct m.slug) members, bool_or(t.kind = 'core') core
    from (select owner_slug from new_rows union select owner_slug from old_rows) c
    join public.team_members m on m.slug = c.owner_slug join public.teams t on t.id = m.team_id
    group by m.team_id
  loop
    perform realtime.send(jsonb_build_object('changed', true, 'members', item.members),
      'collection_changed', 'fpt-collection:' || item.team_id, false);
    if item.core then perform realtime.send(jsonb_build_object('changed', true), 'collection_changed', 'fpt-collection', false); end if;
  end loop;
  return null;
end;
$$;

create or replace function public.broadcast_collection_delete()
returns trigger language plpgsql security definer set search_path = public, realtime as $$
declare item record;
begin
  for item in
    select m.team_id, jsonb_agg(distinct m.slug) members, bool_or(t.kind = 'core') core
    from (select distinct owner_slug from old_rows) c
    join public.team_members m on m.slug = c.owner_slug join public.teams t on t.id = m.team_id
    group by m.team_id
  loop
    perform realtime.send(jsonb_build_object('changed', true, 'members', item.members),
      'collection_changed', 'fpt-collection:' || item.team_id, false);
    if item.core then perform realtime.send(jsonb_build_object('changed', true), 'collection_changed', 'fpt-collection', false); end if;
  end loop;
  return null;
end;
$$;
drop trigger if exists broadcast_fpt_collection_change on public.collection_items;
drop function if exists public.broadcast_collection_change();
drop trigger if exists broadcast_fpt_collection_insert on public.collection_items;
drop trigger if exists broadcast_fpt_collection_update on public.collection_items;
drop trigger if exists broadcast_fpt_collection_delete on public.collection_items;
create trigger broadcast_fpt_collection_insert after insert on public.collection_items
  referencing new table as new_rows for each statement execute function public.broadcast_collection_insert();
create trigger broadcast_fpt_collection_update after update on public.collection_items
  referencing old table as old_rows new table as new_rows for each statement execute function public.broadcast_collection_update();
create trigger broadcast_fpt_collection_delete after delete on public.collection_items
  referencing old table as old_rows for each statement execute function public.broadcast_collection_delete();

create or replace function public.broadcast_loan_change()
returns trigger language plpgsql security definer set search_path = public, realtime as $$
declare owner text := case when tg_op = 'DELETE' then old.owner_slug else new.owner_slug end;
  team uuid := public.member_team(owner);
begin
  if team is not null then
    perform realtime.send(jsonb_build_object('changed', true), 'loans_changed', 'fpt-loans:' || team, false);
  end if;
  if team is null or team = public.core_team_id() then
    perform realtime.send(jsonb_build_object('changed', true), 'loans_changed', 'fpt-loans', false);
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function public.broadcast_collection_insert(), public.broadcast_collection_update(),
  public.broadcast_collection_delete() from public, anon, authenticated;

notify pgrst, 'reload schema';

commit;

-- Rollback (manuale):
--   ripristinare le funzioni patchate da un backup di pg_get_functiondef,
--   drop trigger loans_same_team / matches_same_team,
--   ricreare broadcast_collection_change() e il trigger statement-level storico,
--   drop table team_invites, beta_settings; alter table team_members drop column team_id; drop table teams.
