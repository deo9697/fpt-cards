-- I match registrati devono sopravvivere all'eliminazione del mazzo.
--
-- Prima: matches.deck_id aveva una FK verso decks con ON DELETE CASCADE, quindi
-- eliminare un mazzo cancellava tutto il suo storico (statistiche, timeline,
-- serie di vittorie). L'XP resta in member_progression/xp_transactions, ma le
-- statistiche no.
--
-- Dopo:
--   * matches.deck_name conserva il nome del mazzo (copia, riempita da trigger
--     e allineata quando il mazzo viene rinominato);
--   * la FK matches_deck_id_fkey viene rimossa: deck_id resta com'era anche
--     dopo l'eliminazione, così raggruppamenti e filtri per mazzo continuano a
--     funzionare. register_match valida già che il mazzo esista e sia tuo;
--   * get_stats / get_team_stats / get_match_timeline usano LEFT JOIN e, per i
--     mazzi eliminati, il nome salvato.
-- La firma delle funzioni non cambia: nessun cambio lato app richiesto.

begin;

alter table public.matches add column if not exists deck_name text not null default '';

update public.matches m
   set deck_name = d.name
  from public.decks d
 where d.id = m.deck_id
   and m.deck_name is distinct from d.name;

create or replace function public.matches_fill_deck_name()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare found_name text;
begin
  if coalesce(new.deck_name, '') = '' or (tg_op = 'UPDATE' and new.deck_id is distinct from old.deck_id) then
    select d.name into found_name from public.decks d where d.id = new.deck_id;
    new.deck_name := coalesce(found_name, new.deck_name, '');
  end if;
  return new;
end;
$function$;

drop trigger if exists matches_fill_deck_name on public.matches;
create trigger matches_fill_deck_name
  before insert or update of deck_id on public.matches
  for each row execute function public.matches_fill_deck_name();

create or replace function public.decks_sync_match_deck_name()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
begin
  update public.matches set deck_name = new.name
   where deck_id = new.id and deck_name is distinct from new.name;
  return new;
end;
$function$;

drop trigger if exists decks_sync_match_deck_name on public.decks;
create trigger decks_sync_match_deck_name
  after update of name on public.decks
  for each row when (old.name is distinct from new.name)
  execute function public.decks_sync_match_deck_name();

revoke all on function public.matches_fill_deck_name() from public, anon, authenticated;
revoke all on function public.decks_sync_match_deck_name() from public, anon, authenticated;

alter table public.matches drop constraint if exists matches_deck_id_fkey;

create or replace function public.get_stats(p_token text, p_game text, p_deck_id uuid default null::uuid, p_period text default 'all'::text)
returns table(deck_id uuid, deck_name text, matches integer, wins integer, losses integer, draws integer, win_rate numeric)
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare me text := public.session_member(p_token); since timestamptz;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  since := case p_period when '7d' then now() - interval '7 days' when '30d' then now() - interval '30 days' else '-infinity'::timestamptz end;
  return query select m.deck_id, coalesce(d.name, nullif(m.deck_name, ''), 'Mazzo eliminato'),
    count(*)::integer,
    count(*) filter (where m.result = 'win')::integer,
    count(*) filter (where m.result = 'loss')::integer,
    count(*) filter (where m.result = 'draw')::integer,
    round(count(*) filter (where m.result = 'win')::numeric / greatest(count(*), 1) * 100, 1)
  from public.matches m left join public.decks d on d.id = m.deck_id
  where m.member_slug = me and m.game = p_game and m.played_at >= since
    and (p_deck_id is null or m.deck_id = p_deck_id)
  group by m.deck_id, coalesce(d.name, nullif(m.deck_name, ''), 'Mazzo eliminato')
  order by count(*) desc;
end;
$function$;

create or replace function public.get_team_stats(p_token text, p_game text, p_period text default 'all'::text)
returns table(member_slug text, member_name text, deck_id uuid, deck_name text, matches integer, wins integer, losses integer, draws integer, win_rate numeric)
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare me text := public.session_member(p_token); since timestamptz;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  since := case p_period when '7d' then now() - interval '7 days' when '30d' then now() - interval '30 days' else '-infinity'::timestamptz end;
  return query select m.member_slug, tm.full_name, m.deck_id, coalesce(d.name, nullif(m.deck_name, ''), 'Mazzo eliminato'),
    count(*)::integer,
    count(*) filter (where m.result = 'win')::integer,
    count(*) filter (where m.result = 'loss')::integer,
    count(*) filter (where m.result = 'draw')::integer,
    round(count(*) filter (where m.result = 'win')::numeric / greatest(count(*), 1) * 100, 1)
  from public.matches m
  left join public.decks d on d.id = m.deck_id
  join public.team_members tm on tm.slug = m.member_slug and tm.active and tm.team_id = public.member_team(me)
  where m.game = p_game and m.played_at >= since
  group by m.member_slug, tm.full_name, m.deck_id, coalesce(d.name, nullif(m.deck_name, ''), 'Mazzo eliminato')
  order by tm.full_name, count(*) desc;
end;
$function$;

create or replace function public.get_match_timeline(p_token text, p_game text)
returns table(id uuid, played_at timestamp with time zone, result text, deck_name text, opponent_label text, opponent_deck text, is_team_match boolean, notes text, xp_awarded integer, went_first boolean)
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare me text := public.session_member(p_token);
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  if p_game not in ('yugioh','onepiece') then raise exception 'Gioco non valido'; end if;
  return query select m.id, m.played_at, m.result, coalesce(d.name, nullif(m.deck_name, ''), 'Mazzo eliminato'), m.opponent_label, m.opponent_deck, (m.opponent_member_slug is not null), m.notes, m.xp_awarded, m.went_first
  from public.matches m
  left join public.decks d on d.id = m.deck_id
  where m.member_slug = me and m.game = p_game
  order by m.played_at asc;
end;
$function$;

commit;
