-- F.P.T Cards — Milestone 6: Statistiche (match log per mazzo) + XP/Progression.
-- Migrazione additiva: eseguire dopo supabase-milestone-4-decks.sql.
--
-- Autenticazione: come ogni altra RPC di questo progetto, tutte le funzioni qui
-- sotto sono chiamate dallo STESSO client anon-key indipendentemente dal login
-- (schema custom p_token/session_member, non Supabase Auth) — quindi ogni
-- grant execute va sempre a `anon, authenticated` insieme, mai `authenticated`
-- da solo (regola empirica del progetto, vedi commit supabase-collection-
-- sharing-grants-fix.sql/-fix2.sql: la versione authenticated-only non ha mai
-- funzionato qui).

create table public.matches (
  id uuid primary key default gen_random_uuid(),
  member_slug text not null references public.team_members(slug) on delete cascade,
  game text not null check (game in ('yugioh','onepiece')),
  deck_id uuid not null references public.decks(id) on delete cascade,
  result text not null check (result in ('win','loss','draw')),
  opponent_label text not null default '' check (char_length(opponent_label) <= 120),
  opponent_deck text not null default '' check (char_length(opponent_deck) <= 120),
  notes text not null default '' check (char_length(notes) <= 500),
  xp_awarded integer not null default 0 check (xp_awarded >= 0),
  played_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists matches_member_game_idx on public.matches(member_slug, game, played_at desc);
create index if not exists matches_deck_idx on public.matches(deck_id);

create table public.member_progression (
  member_slug text primary key references public.team_members(slug) on delete cascade,
  total_xp integer not null default 0 check (total_xp >= 0),
  level integer not null default 1 check (level between 1 and 50),
  active_title text not null default '',
  updated_at timestamptz not null default now()
);

create table public.xp_transactions (
  id uuid primary key default gen_random_uuid(),
  member_slug text not null references public.team_members(slug) on delete cascade,
  source_type text not null check (source_type in ('match')),
  source_id uuid not null,
  xp_amount integer not null,
  game text,
  created_at timestamptz not null default now(),
  unique (member_slug, source_type, source_id)
);
create index if not exists xp_transactions_member_day_idx on public.xp_transactions(member_slug, created_at);

alter table public.matches enable row level security;
alter table public.member_progression enable row level security;
alter table public.xp_transactions enable row level security;
revoke all on public.matches, public.member_progression, public.xp_transactions from public, anon, authenticated;

create or replace function public.touch_member_progression_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin new.updated_at = now(); return new; end;
$$;
drop trigger if exists touch_member_progression_updated_at on public.member_progression;
create trigger touch_member_progression_updated_at before update on public.member_progression
for each row execute function public.touch_member_progression_updated_at();

-- Tabella soglie XP->livello: STESSA curva di js/progression.js (LEVEL_THRESHOLDS).
-- Se ritari una delle due, aggiorna anche l'altra: non c'è un'unica fonte
-- condivisa fra client e DB per la V1.
create or replace function public.level_from_xp(p_xp integer)
returns integer language sql immutable as $$
  select count(*)::integer from unnest(array[
    0,75,200,375,600,875,1200,1575,2000,2475,3000,3575,4200,4875,5600,6375,7200,8075,9000,9975,
    11000,12075,13200,14375,15600,16875,18200,19575,21000,22475,24000,25575,27200,28875,30600,
    32375,34200,36075,38000,39975,42000,44075,46200,48375,50600,52875,55200,57575,60000,62475
  ]) as t(threshold) where p_xp >= threshold
$$;

create or replace function public.register_match(
  p_token text, p_game text, p_deck_id uuid, p_result text,
  p_opponent_label text default '', p_opponent_deck text default '', p_notes text default ''
)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  me text := public.session_member(p_token);
  base_xp integer; already_today integer; awarded integer; new_match_id uuid;
  level_before integer; total_before integer; total_after integer; level_after integer;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  if p_game not in ('yugioh','onepiece') then raise exception 'Gioco non valido'; end if;
  if p_result not in ('win','loss','draw') then raise exception 'Risultato non valido'; end if;
  if not exists(select 1 from public.decks where id = p_deck_id and owner_slug = me and game = p_game) then
    raise exception 'Mazzo non trovato per questo gioco';
  end if;

  base_xp := 10 + case p_result when 'win' then 5 when 'draw' then 2 else 0 end;
  select coalesce(sum(xp_amount), 0) into already_today from public.xp_transactions
    where member_slug = me and source_type = 'match' and created_at::date = current_date;
  awarded := least(base_xp, greatest(0, 100 - already_today));

  insert into public.matches(member_slug, game, deck_id, result, opponent_label, opponent_deck, notes, xp_awarded)
    values (me, p_game, p_deck_id, p_result, left(trim(p_opponent_label), 120), left(trim(p_opponent_deck), 120), left(trim(p_notes), 500), awarded)
    returning id into new_match_id;
  insert into public.xp_transactions(member_slug, source_type, source_id, xp_amount, game)
    values (me, 'match', new_match_id, awarded, p_game);

  insert into public.member_progression(member_slug, total_xp, level) values (me, 0, 1)
    on conflict (member_slug) do nothing;
  select total_xp, level into total_before, level_before from public.member_progression where member_slug = me;
  total_after := total_before + awarded;
  level_after := public.level_from_xp(total_after);
  update public.member_progression set total_xp = total_after, level = level_after where member_slug = me;

  return jsonb_build_object(
    'match', jsonb_build_object('id', new_match_id, 'deckId', p_deck_id, 'result', p_result, 'opponentLabel', p_opponent_label, 'opponentDeck', p_opponent_deck, 'notes', p_notes, 'xpAwarded', awarded, 'playedAt', now()),
    'xpAwarded', awarded, 'totalXp', total_after, 'level', level_after, 'levelUp', level_after > level_before
  );
end;
$$;

create or replace function public.get_my_progression(p_token text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token); total integer; member_level integer; used_today integer;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  insert into public.member_progression(member_slug, total_xp, level) values (me, 0, 1)
    on conflict (member_slug) do nothing;
  select total_xp, level into total, member_level from public.member_progression where member_slug = me;
  select coalesce(sum(xp_amount), 0) into used_today from public.xp_transactions
    where member_slug = me and source_type = 'match' and created_at::date = current_date;
  return jsonb_build_object('totalXp', total, 'level', member_level, 'xpToday', used_today, 'dailyCap', 100);
end;
$$;

create or replace function public.get_stats(p_token text, p_game text, p_deck_id uuid default null, p_period text default 'all')
returns table(deck_id uuid, deck_name text, matches integer, wins integer, losses integer, draws integer, win_rate numeric)
language plpgsql security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token); since timestamptz;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  since := case p_period when '7d' then now() - interval '7 days' when '30d' then now() - interval '30 days' else '-infinity'::timestamptz end;
  return query select d.id, d.name,
    count(*)::integer,
    count(*) filter (where m.result = 'win')::integer,
    count(*) filter (where m.result = 'loss')::integer,
    count(*) filter (where m.result = 'draw')::integer,
    round(count(*) filter (where m.result = 'win')::numeric / greatest(count(*), 1) * 100, 1)
  from public.matches m join public.decks d on d.id = m.deck_id
  where m.member_slug = me and m.game = p_game and m.played_at >= since
    and (p_deck_id is null or m.deck_id = p_deck_id)
  group by d.id, d.name
  order by count(*) desc;
end;
$$;

create or replace function public.get_team_stats(p_token text, p_game text, p_period text default 'all')
returns table(member_slug text, member_name text, deck_id uuid, deck_name text, matches integer, wins integer, losses integer, draws integer, win_rate numeric)
language plpgsql security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token); since timestamptz;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  since := case p_period when '7d' then now() - interval '7 days' when '30d' then now() - interval '30 days' else '-infinity'::timestamptz end;
  return query select m.member_slug, tm.full_name, d.id, d.name,
    count(*)::integer,
    count(*) filter (where m.result = 'win')::integer,
    count(*) filter (where m.result = 'loss')::integer,
    count(*) filter (where m.result = 'draw')::integer,
    round(count(*) filter (where m.result = 'win')::numeric / greatest(count(*), 1) * 100, 1)
  from public.matches m
  join public.decks d on d.id = m.deck_id
  join public.team_members tm on tm.slug = m.member_slug and tm.active
  where m.game = p_game and m.played_at >= since
  group by m.member_slug, tm.full_name, d.id, d.name
  order by tm.full_name, count(*) desc;
end;
$$;

create or replace function public.delete_match(p_token text, p_id uuid)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token); refund integer;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  select xp_awarded into refund from public.matches where id = p_id and member_slug = me;
  if refund is null then raise exception 'Match non trovato o non modificabile'; end if;
  delete from public.xp_transactions where member_slug = me and source_type = 'match' and source_id = p_id;
  delete from public.matches where id = p_id and member_slug = me;
  update public.member_progression set total_xp = greatest(0, total_xp - refund),
    level = public.level_from_xp(greatest(0, total_xp - refund))
  where member_slug = me;
end;
$$;

revoke all on function public.register_match(text,text,uuid,text,text,text,text), public.get_my_progression(text), public.get_stats(text,text,uuid,text), public.get_team_stats(text,text,text), public.delete_match(text,uuid) from public, anon, authenticated;
grant execute on function public.register_match(text,text,uuid,text,text,text,text), public.get_my_progression(text), public.get_stats(text,text,uuid,text), public.get_team_stats(text,text,text), public.delete_match(text,uuid) to anon, authenticated;

notify pgrst, 'reload schema';

-- Rollback:
-- drop function if exists public.register_match(text,text,uuid,text,text,text,text);
-- drop function if exists public.get_my_progression(text);
-- drop function if exists public.get_stats(text,text,uuid,text);
-- drop function if exists public.get_team_stats(text,text,text);
-- drop function if exists public.delete_match(text,uuid);
-- drop function if exists public.level_from_xp(integer);
-- drop table if exists public.xp_transactions;
-- drop table if exists public.member_progression;
-- drop table if exists public.matches;
-- notify pgrst, 'reload schema';
