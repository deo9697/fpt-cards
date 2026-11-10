-- Private Yu-Gi-Oh! multiplayer state. Browsers use the authenticated application
-- API; neither participants nor other team members can SELECT hidden state.
-- Additive migration: no existing team, deck, notification or match is modified.
begin;
set local lock_timeout = '5s';

create table public.yugioh_duels (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id),
  host_slug text not null references public.team_members(slug),
  guest_slug text not null references public.team_members(slug),
  status text not null default 'waiting'
    check (status in ('waiting', 'setup', 'playing', 'finished', 'declined', 'cancelled')),
  version integer not null default 1 check (version >= 1),
  host_deck jsonb check (host_deck is null or jsonb_typeof(host_deck) = 'object'),
  host_lp integer not null check (host_lp between 1 and 999999),
  first_player integer not null default 0 check (first_player in (0, 1)),
  state jsonb check (state is null or jsonb_typeof(state) = 'object'),
  previous_state jsonb check (previous_state is null or jsonb_typeof(previous_state) = 'object'),
  ready jsonb not null default '[false,false]'::jsonb
    check (ready in ('[false,false]'::jsonb, '[false,true]'::jsonb, '[true,false]'::jsonb, '[true,true]'::jsonb)),
  last_action_id uuid,
  last_action_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours'),
  constraint yugioh_duels_distinct_players check (host_slug <> guest_slug),
  constraint yugioh_duels_action_participant check (last_action_by is null or last_action_by in (host_slug, guest_slug)),
  constraint yugioh_duels_expiry check (expires_at > created_at),
  constraint yugioh_duels_started_state check (status not in ('setup', 'playing', 'finished') or state is not null),
  constraint yugioh_duels_waiting_deck check (status <> 'waiting' or host_deck is not null)
);

create index yugioh_duels_host_recent_idx on public.yugioh_duels(team_id, host_slug, updated_at desc);
create index yugioh_duels_guest_recent_idx on public.yugioh_duels(team_id, guest_slug, updated_at desc);
create index yugioh_duels_host_created_idx on public.yugioh_duels(host_slug, created_at desc);
create index yugioh_duels_expiry_idx on public.yugioh_duels(expires_at)
  where status in ('waiting', 'setup', 'playing');

alter table public.yugioh_duels enable row level security;
revoke all on table public.yugioh_duels from public, anon, authenticated;
grant select, insert, update, delete on table public.yugioh_duels to service_role;
comment on table public.yugioh_duels is
  'Server-only manual Yu-Gi-Oh! duel state. Contains hidden cards. No client SELECT grants, RLS policies, public views or Realtime publication.';

create function public.yugioh_duel_guard()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare participants integer;
begin
  if tg_op = 'UPDATE' then
    if new.id is distinct from old.id or new.team_id is distinct from old.team_id
      or new.host_slug is distinct from old.host_slug or new.guest_slug is distinct from old.guest_slug
      or new.created_at is distinct from old.created_at then
      raise exception 'I partecipanti e il team della partita non possono essere modificati' using errcode = '23514';
    end if;
    if new.version <> old.version + 1 then
      raise exception 'La versione della partita deve avanzare di una posizione' using errcode = '23514';
    end if;
  end if;
  select count(*) into participants from public.team_members m
    where m.slug in (new.host_slug, new.guest_slug) and m.team_id = new.team_id and m.active
      and coalesce(pg_catalog.to_jsonb(m)->>'kind', 'legacy') = 'legacy';
  if participants <> 2 then
    raise exception 'La partita richiede due membri attivi dello stesso team' using errcode = '23514';
  end if;
  new.updated_at := pg_catalog.clock_timestamp();
  return new;
end;
$$;
revoke all on function public.yugioh_duel_guard() from public, anon, authenticated;
grant execute on function public.yugioh_duel_guard() to service_role;
create trigger yugioh_duel_guard before insert or update on public.yugioh_duels
  for each row execute function public.yugioh_duel_guard();

-- Serialize invitation creation for one host. Read-before-insert checks in an
-- HTTP worker alone would permit concurrent requests to bypass pending/rate
-- limits and send duplicate pushes. The advisory lock lives for this RPC's
-- transaction; no client role may call it or provide a trusted invite snapshot.
create function public.yugioh_duel_insert_invite(p_invite jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare candidate public.yugioh_duels; inserted public.yugioh_duels; current_time_stamp timestamptz;
begin
  if pg_catalog.jsonb_typeof(p_invite) is distinct from 'object' then
    raise exception 'DUEL_INVITE_INVALID' using errcode = '22023';
  end if;
  select * into candidate from pg_catalog.jsonb_populate_record(null::public.yugioh_duels,
    pg_catalog.jsonb_build_object('status', 'waiting', 'version', 1, 'first_player', 0,
      'ready', '[false,false]'::jsonb) || p_invite);
  if candidate.id is null or candidate.host_slug is null or candidate.status <> 'waiting'
    or candidate.version <> 1 or candidate.state is not null then
    raise exception 'DUEL_INVITE_INVALID' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('yugioh-duel-invite:' || candidate.host_slug, 0));
  if exists (select 1 from public.yugioh_duels d where d.id = candidate.id) then return null; end if;
  current_time_stamp := pg_catalog.clock_timestamp();
  if exists (select 1 from public.yugioh_duels d where d.host_slug = candidate.host_slug
    and d.guest_slug = candidate.guest_slug and d.status = 'waiting' and d.expires_at > current_time_stamp) then
    raise exception 'DUEL_INVITE_PENDING' using errcode = 'P1001';
  end if;
  if (select count(*) from public.yugioh_duels d where d.host_slug = candidate.host_slug
    and d.created_at >= current_time_stamp - interval '1 minute') >= 5 then
    raise exception 'DUEL_INVITE_RATE_LIMIT' using errcode = 'P1002';
  end if;
  candidate.created_at := current_time_stamp;
  candidate.updated_at := current_time_stamp;
  candidate.expires_at := current_time_stamp + interval '24 hours';
  insert into public.yugioh_duels select (candidate).* on conflict (id) do nothing returning * into inserted;
  if not found then return null; end if;
  return pg_catalog.to_jsonb(inserted);
end;
$$;
revoke all on function public.yugioh_duel_insert_invite(jsonb) from public, anon, authenticated;
grant execute on function public.yugioh_duel_insert_invite(jsonb) to service_role;

-- Reuse the existing membership-only resolver public.onepiece_duel_identity(text).
-- It accepts no target member or team and never reads any game state.
notify pgrst, 'reload schema';
commit;
