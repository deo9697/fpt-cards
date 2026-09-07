-- F.P.T Cards — Milestone 10: Missioni giornaliere.
-- Migrazione additiva: eseguire dopo supabase-milestone-9-cosmetics.sql.
--
-- V1 fissa 3 missioni (le "più fattibili" scelte in sessione, niente pool
-- random per ora): carica 100 carte in raccolta, registra un mazzo nuovo,
-- registra l'esito di un duello. Il catalogo (id/target/xp) vive qui E in
-- js/missions.js — stessa scelta già fatta per COSMETICS in cosmetics.js,
-- non c'è un'unica fonte condivisa fra client e DB per la V1.
--
-- Scelta progettuale: NIENTE modifiche alle RPC di scrittura già live
-- (save_collection_item/_batch, save_fast_scan_chunk, save_deck_with_box,
-- save_deck, register_match) — sono i percorsi più trafficati dell'app e
-- riscriverli per intero qui (create or replace richiede il body completo)
-- sarebbe il modo più facile per introdurre una regressione silenziosa.
-- Il progresso missione viene invece calcolato con dei TRIGGER after
-- insert/update sulle tabelle collection_items/decks/matches: totalmente
-- disaccoppiato da come la riga ci è arrivata, zero rischio sulle RPC.
--
-- Auth: come sempre in questo progetto, grant execute va a `anon,
-- authenticated` insieme, mai `authenticated` da solo (regola empirica,
-- vedi commit supabase-collection-sharing-grants-fix.sql/-fix2.sql).

create table if not exists public.member_daily_missions (
  member_slug text not null references public.team_members(slug) on delete cascade,
  mission_id text not null check (char_length(mission_id) between 1 and 60),
  mission_day date not null default current_date,
  progress integer not null default 0 check (progress >= 0),
  target integer not null check (target > 0),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (member_slug, mission_id, mission_day)
);
alter table public.member_daily_missions enable row level security;
revoke all on public.member_daily_missions from public, anon, authenticated;

-- Helper interno (non esposto via RPC, stesso trattamento di session_member/
-- level_from_xp): incrementa il progresso di UNA missione di oggi e, alla
-- prima volta che raggiunge il target, accredita l'XP bonus direttamente su
-- member_progression. completed_at fa da guardia anti-doppio-accredito.
create or replace function public.bump_daily_mission(
  p_member text, p_mission_id text, p_target integer, p_delta integer, p_xp_reward integer
) returns void language plpgsql security definer set search_path = public, extensions as $$
declare cur_progress integer; already_done boolean; new_progress integer;
  total_before integer; total_after integer; level_after integer;
begin
  if p_member is null or p_delta <= 0 then return; end if;

  insert into public.member_daily_missions(member_slug, mission_id, mission_day, progress, target)
    values (p_member, p_mission_id, current_date, 0, p_target)
    on conflict (member_slug, mission_id, mission_day) do nothing;

  select progress, (completed_at is not null) into cur_progress, already_done
    from public.member_daily_missions
    where member_slug = p_member and mission_id = p_mission_id and mission_day = current_date
    for update;

  if already_done then return; end if;

  new_progress := least(p_target, cur_progress + p_delta);
  update public.member_daily_missions set progress = new_progress,
    completed_at = case when new_progress >= p_target then now() else null end
    where member_slug = p_member and mission_id = p_mission_id and mission_day = current_date;

  if new_progress >= p_target and p_xp_reward > 0 then
    insert into public.member_progression(member_slug, total_xp, level) values (p_member, 0, 1)
      on conflict (member_slug) do nothing;
    select total_xp into total_before from public.member_progression where member_slug = p_member;
    total_after := total_before + p_xp_reward;
    level_after := public.level_from_xp(total_after);
    update public.member_progression set total_xp = total_after, level = level_after where member_slug = p_member;
  end if;
end;
$$;

create or replace function public.trg_mission_on_match()
returns trigger language plpgsql security definer set search_path = public, extensions as $$
begin
  perform public.bump_daily_mission(new.member_slug, 'daily_duel_log', 1, 1, 25);
  return new;
end;
$$;
drop trigger if exists mission_on_match_insert on public.matches;
create trigger mission_on_match_insert after insert on public.matches
for each row execute function public.trg_mission_on_match();

create or replace function public.trg_mission_on_deck()
returns trigger language plpgsql security definer set search_path = public, extensions as $$
begin
  perform public.bump_daily_mission(new.owner_slug, 'daily_deck_complete', 1, 1, 25);
  return new;
end;
$$;
drop trigger if exists mission_on_deck_insert on public.decks;
create trigger mission_on_deck_insert after insert on public.decks
for each row execute function public.trg_mission_on_deck();

create or replace function public.trg_mission_on_collection()
returns trigger language plpgsql security definer set search_path = public, extensions as $$
declare delta integer;
begin
  delta := new.quantity_owned - coalesce(old.quantity_owned, 0);
  if delta > 0 then
    perform public.bump_daily_mission(new.owner_slug, 'daily_collection_100', 100, delta, 40);
  end if;
  return new;
end;
$$;
drop trigger if exists mission_on_collection_change on public.collection_items;
create trigger mission_on_collection_change after insert or update of quantity_owned on public.collection_items
for each row execute function public.trg_mission_on_collection();

-- Unica RPC esposta al client: legge le 3 missioni fisse di oggi, con
-- progresso a 0 per quelle mai toccate (nessuna riga da creare in lettura).
create or replace function public.get_my_daily_missions(p_token text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token); result jsonb;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  select jsonb_agg(jsonb_build_object(
    'id', c.mission_id, 'progress', coalesce(m.progress, 0), 'target', c.target,
    'completed', coalesce(m.completed_at is not null, false), 'xpReward', c.xp_reward
  ) order by c.sort_order)
  into result
  from (values
    ('daily_collection_100', 100, 40, 1),
    ('daily_deck_complete', 1, 25, 2),
    ('daily_duel_log', 1, 25, 3)
  ) as c(mission_id, target, xp_reward, sort_order)
  left join public.member_daily_missions m
    on m.member_slug = me and m.mission_id = c.mission_id and m.mission_day = current_date;
  return coalesce(result, '[]'::jsonb);
end;
$$;

grant execute on function public.get_my_daily_missions(text) to anon, authenticated;
