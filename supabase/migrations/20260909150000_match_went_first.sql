-- F.P.T Cards — Statistiche: flag "sei andato primo?" sul match (chi ha vinto
-- il tiro di dado) + dettagli completi nello storico per il resoconto al tap
-- su un match recente. Migrazione additiva.
-- Eseguire dopo supabase-milestone-12-match-timeline.sql (o le migration
-- equivalenti già applicate a questo schema).

alter table public.matches add column if not exists went_first boolean;

-- register_match: aggiungere un parametro cambia la firma della funzione agli
-- occhi di Postgres (overload distinto, non una sostituzione in-place) — la
-- firma precedente (10 argomenti) va droppata esplicitamente per non lasciarla
-- comunque grantata e chiamabile in parallelo alla nuova.
create or replace function public.register_match(
  p_token text, p_game text, p_deck_id uuid, p_result text,
  p_opponent_label text default '', p_opponent_deck text default '', p_notes text default '',
  p_opponent_member_slug text default null, p_opponent_deck_id uuid default null,
  p_opponent_deck_name text default '', p_went_first boolean default null
)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  me text := public.session_member(p_token);
  base_xp integer; already_today integer; awarded integer; new_match_id uuid;
  level_before integer; total_before integer; total_after integer; level_after integer;
  opp_name text; my_name text; opp_deck_name text; my_deck_name text; opp_deck_id uuid;
  opp_result text; opp_base_xp integer; opp_already_today integer; opp_awarded integer; opp_match_id uuid;
  opp_level_before integer; opp_total_before integer; opp_total_after integer; opp_level_after integer;
  opp_went_first boolean := case when p_went_first is null then null else not p_went_first end;
  final_opponent_label text := left(trim(p_opponent_label), 120);
  final_opponent_deck text := left(trim(p_opponent_deck), 120);
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  if p_game not in ('yugioh','onepiece') then raise exception 'Gioco non valido'; end if;
  if p_result not in ('win','loss','draw') then raise exception 'Risultato non valido'; end if;
  select name into my_deck_name from public.decks where id = p_deck_id and owner_slug = me and game = p_game;
  if my_deck_name is null then raise exception 'Mazzo non trovato per questo gioco'; end if;

  if p_opponent_member_slug is not null then
    if p_opponent_member_slug = me then raise exception 'Non puoi sfidare te stesso'; end if;
    select full_name into opp_name from public.team_members where slug = p_opponent_member_slug and active;
    if opp_name is null then raise exception 'Compagno di squadra non valido'; end if;
    opp_deck_id := p_opponent_deck_id;
    if opp_deck_id is not null then
      select name into opp_deck_name from public.decks where id = opp_deck_id and owner_slug = p_opponent_member_slug and game = p_game;
      if opp_deck_name is null then raise exception 'Mazzo del compagno non trovato per questo gioco'; end if;
    elsif char_length(trim(p_opponent_deck_name)) > 0 then
      insert into public.decks(owner_slug, game, name, format, created_source) values (p_opponent_member_slug, p_game, left(trim(p_opponent_deck_name), 80), 'TCG Avanzato', 'match_tracker')
        returning id, name into opp_deck_id, opp_deck_name;
    else
      raise exception 'Specifica il mazzo del compagno';
    end if;
    select full_name into my_name from public.team_members where slug = me;
    final_opponent_label := opp_name;
    final_opponent_deck := opp_deck_name;
    opp_result := case p_result when 'win' then 'loss' when 'loss' then 'win' else 'draw' end;
  end if;

  base_xp := 10 + case p_result when 'win' then 5 when 'draw' then 2 else 0 end;
  select coalesce(sum(xp_amount), 0) into already_today from public.xp_transactions
    where member_slug = me and source_type = 'match' and created_at::date = current_date;
  awarded := least(base_xp, greatest(0, 100 - already_today));

  insert into public.matches(member_slug, game, deck_id, result, opponent_label, opponent_deck, notes, xp_awarded, opponent_member_slug, opponent_deck_id, went_first)
    values (me, p_game, p_deck_id, p_result, final_opponent_label, final_opponent_deck, left(trim(p_notes), 500), awarded, p_opponent_member_slug, opp_deck_id, p_went_first)
    returning id into new_match_id;
  insert into public.xp_transactions(member_slug, source_type, source_id, xp_amount, game)
    values (me, 'match', new_match_id, awarded, p_game);

  insert into public.member_progression(member_slug, total_xp, level) values (me, 0, 1)
    on conflict (member_slug) do nothing;
  select total_xp, level into total_before, level_before from public.member_progression where member_slug = me;
  total_after := total_before + awarded;
  level_after := public.level_from_xp(total_after);
  update public.member_progression set total_xp = total_after, level = level_after where member_slug = me;

  if p_opponent_member_slug is not null then
    opp_base_xp := 10 + case opp_result when 'win' then 5 when 'draw' then 2 else 0 end;
    select coalesce(sum(xp_amount), 0) into opp_already_today from public.xp_transactions
      where member_slug = p_opponent_member_slug and source_type = 'match' and created_at::date = current_date;
    opp_awarded := least(opp_base_xp, greatest(0, 100 - opp_already_today));

    insert into public.matches(member_slug, game, deck_id, result, opponent_label, opponent_deck, notes, xp_awarded, opponent_member_slug, opponent_deck_id, mirror_match_id, went_first)
      values (p_opponent_member_slug, p_game, opp_deck_id, opp_result, coalesce(my_name, ''), my_deck_name, '', opp_awarded, me, p_deck_id, new_match_id, opp_went_first)
      returning id into opp_match_id;
    insert into public.xp_transactions(member_slug, source_type, source_id, xp_amount, game)
      values (p_opponent_member_slug, 'match', opp_match_id, opp_awarded, p_game);

    insert into public.member_progression(member_slug, total_xp, level) values (p_opponent_member_slug, 0, 1)
      on conflict (member_slug) do nothing;
    select total_xp, level into opp_total_before, opp_level_before from public.member_progression where member_slug = p_opponent_member_slug;
    opp_total_after := opp_total_before + opp_awarded;
    opp_level_after := public.level_from_xp(opp_total_after);
    update public.member_progression set total_xp = opp_total_after, level = opp_level_after where member_slug = p_opponent_member_slug;

    update public.matches set mirror_match_id = opp_match_id where id = new_match_id;
  end if;

  return jsonb_build_object(
    'match', jsonb_build_object('id', new_match_id, 'deckId', p_deck_id, 'result', p_result, 'opponentLabel', final_opponent_label, 'opponentDeck', final_opponent_deck, 'notes', p_notes, 'xpAwarded', awarded, 'playedAt', now(), 'wentFirst', p_went_first),
    'xpAwarded', awarded, 'totalXp', total_after, 'level', level_after, 'levelUp', level_after > level_before
  );
end;
$$;

revoke all on function public.register_match(text,text,uuid,text,text,text,text,text,uuid,text,boolean) from public, anon, authenticated;
grant execute on function public.register_match(text,text,uuid,text,text,text,text,text,uuid,text,boolean) to anon, authenticated;
drop function if exists public.register_match(text,text,uuid,text,text,text,text,text,uuid,text);

-- get_match_timeline: la lista "Ultimi match" alimenta anche il resoconto al
-- tap su un match — servono id/notes/xp/went_first, non solo i campi per il
-- grafico. Cambiare le colonne restituite non è un CREATE OR REPLACE valido
-- (Postgres non permette di cambiare il return type di una funzione
-- esistente): drop esplicito prima di ricrearla.
drop function if exists public.get_match_timeline(text,text);
create or replace function public.get_match_timeline(p_token text, p_game text)
returns table(id uuid, played_at timestamptz, result text, deck_name text, opponent_label text, opponent_deck text, is_team_match boolean, notes text, xp_awarded integer, went_first boolean)
language plpgsql security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token);
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  if p_game not in ('yugioh','onepiece') then raise exception 'Gioco non valido'; end if;
  return query select m.id, m.played_at, m.result, d.name, m.opponent_label, m.opponent_deck, (m.opponent_member_slug is not null), m.notes, m.xp_awarded, m.went_first
  from public.matches m
  join public.decks d on d.id = m.deck_id
  where m.member_slug = me and m.game = p_game
  order by m.played_at asc;
end;
$$;
revoke all on function public.get_match_timeline(text,text) from public, anon, authenticated;
grant execute on function public.get_match_timeline(text,text) to anon, authenticated;

notify pgrst, 'reload schema';
