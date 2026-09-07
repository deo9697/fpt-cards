-- F.P.T Cards — Milestone 8: mazzo al volo per un compagno senza mazzo.
-- Migrazione additiva: eseguire dopo supabase-milestone-7-team-h2h.sql.
--
-- Bug d'uso reale (test con un amico, 2026-09-07): registrando un match
-- "Compagno di squadra", se quel compagno non aveva ancora nessun mazzo per
-- il gioco selezionato il select "Mazzo del compagno" restava vuoto e il
-- pulsante "Registra" restava disabilitato — nessun modo di procedere.
--
-- Scartata l'idea di far "prendere in prestito" un mazzo di un altro membro:
-- avrebbe falsato le statistiche per-mazzo del vero proprietario. Soluzione:
-- chi registra il match può scrivere il nome del mazzo del compagno, e il
-- sistema crea per lui un mazzo minimo (vuoto, senza carte) intestato al suo
-- slug — da quel momento in poi è un mazzo vero, riappare nel suo elenco e
-- nelle prossime partite si può selezionare normalmente.
--
-- Come per le altre RPC del progetto, grant sempre a `anon, authenticated`
-- insieme (schema custom p_token/session_member, non Supabase Auth).

create or replace function public.register_match(
  p_token text, p_game text, p_deck_id uuid, p_result text,
  p_opponent_label text default '', p_opponent_deck text default '', p_notes text default '',
  p_opponent_member_slug text default null, p_opponent_deck_id uuid default null,
  p_opponent_deck_name text default ''
)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  me text := public.session_member(p_token);
  base_xp integer; already_today integer; awarded integer; new_match_id uuid;
  level_before integer; total_before integer; total_after integer; level_after integer;
  opp_name text; my_name text; opp_deck_name text; my_deck_name text; opp_deck_id uuid;
  opp_result text; opp_base_xp integer; opp_already_today integer; opp_awarded integer; opp_match_id uuid;
  opp_level_before integer; opp_total_before integer; opp_total_after integer; opp_level_after integer;
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
      insert into public.decks(owner_slug, game, name, format) values (p_opponent_member_slug, p_game, left(trim(p_opponent_deck_name), 80), 'TCG Avanzato')
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

  insert into public.matches(member_slug, game, deck_id, result, opponent_label, opponent_deck, notes, xp_awarded, opponent_member_slug, opponent_deck_id)
    values (me, p_game, p_deck_id, p_result, final_opponent_label, final_opponent_deck, left(trim(p_notes), 500), awarded, p_opponent_member_slug, opp_deck_id)
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

    insert into public.matches(member_slug, game, deck_id, result, opponent_label, opponent_deck, notes, xp_awarded, opponent_member_slug, opponent_deck_id, mirror_match_id)
      values (p_opponent_member_slug, p_game, opp_deck_id, opp_result, coalesce(my_name, ''), my_deck_name, '', opp_awarded, me, p_deck_id, new_match_id)
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
    'match', jsonb_build_object('id', new_match_id, 'deckId', p_deck_id, 'result', p_result, 'opponentLabel', final_opponent_label, 'opponentDeck', final_opponent_deck, 'notes', p_notes, 'xpAwarded', awarded, 'playedAt', now()),
    'xpAwarded', awarded, 'totalXp', total_after, 'level', level_after, 'levelUp', level_after > level_before
  );
end;
$$;

revoke all on function public.register_match(text,text,uuid,text,text,text,text,text,uuid,text) from public, anon, authenticated;
grant execute on function public.register_match(text,text,uuid,text,text,text,text,text,uuid,text) to anon, authenticated;

-- La firma precedente (9 argomenti, senza p_opponent_deck_name) resta come
-- overload distinto agli occhi di Postgres: va droppata per evitare
-- ambiguità PostgREST fra le due firme alla chiamata RPC.
drop function if exists public.register_match(text,text,uuid,text,text,text,text,text,uuid);

notify pgrst, 'reload schema';

-- Rollback: ripristinare la versione a 9 argomenti da
-- supabase-milestone-7-team-h2h.sql (e ri-droppare questa a 10).
-- notify pgrst, 'reload schema';
