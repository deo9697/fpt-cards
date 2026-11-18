-- Automatic personal practice is separate from team invitations/results.
-- Hidden state is accessible exclusively through the authenticated server API.
begin;
set local lock_timeout = '5s';

create table public.yugioh_practice_sessions (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  owner_slug text not null references public.team_members(slug) on delete cascade,
  status text not null check (status in ('playing','finished')),
  version integer not null default 1 check (version >= 1),
  state jsonb not null check (jsonb_typeof(state)='object' and (state->>'mode'='auto') is true),
  start_request_id uuid not null,
  start_request_ids uuid[] not null check (cardinality(start_request_ids) between 1 and 16 and array_position(start_request_ids,null) is null and (start_request_id=any(start_request_ids)) is true),
  last_action_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null default (now()+interval '24 hours'),
  unique (team_id,owner_slug),
  check (expires_at > created_at),
  check (octet_length(state::text) <= 4200000)
);

alter table public.yugioh_practice_sessions enable row level security;
revoke all on table public.yugioh_practice_sessions from public, anon, authenticated;
grant select,insert,update,delete on table public.yugioh_practice_sessions to service_role;

create function public.yugioh_practice_guard()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if tg_op='UPDATE' then
    if new.team_id is distinct from old.team_id or new.owner_slug is distinct from old.owner_slug then
      raise exception 'Il proprietario della prova non può essere modificato' using errcode='23514';
    end if;
    if new.version <> old.version+1 then
      raise exception 'La versione della prova deve avanzare di una posizione' using errcode='23514';
    end if;
  end if;
  if not exists (select 1 from public.team_members m where m.slug=new.owner_slug and m.team_id=new.team_id and m.active and coalesce(pg_catalog.to_jsonb(m)->>'kind','legacy')='legacy') then
    raise exception 'La prova richiede un membro attivo del team' using errcode='23514';
  end if;
  new.updated_at := pg_catalog.clock_timestamp();
  return new;
end;
$$;
revoke all on function public.yugioh_practice_guard() from public,anon,authenticated;
grant execute on function public.yugioh_practice_guard() to service_role;
create trigger yugioh_practice_guard before insert or update on public.yugioh_practice_sessions for each row execute function public.yugioh_practice_guard();

comment on table public.yugioh_practice_sessions is 'Server-only automatic personal practice. One current session per team/member, no PvP invitations, notifications, shared stats or Realtime publication.';
commit;
