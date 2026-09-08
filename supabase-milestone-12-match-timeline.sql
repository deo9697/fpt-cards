-- F.P.T Cards — Milestone 12: storico ordinato dei match per il grafico
-- "Andamento giocatore" (win rate progressivo) e la lista "Ultimi match"
-- nella panoramica Statistiche > Io.
-- Migrazione additiva: sola lettura, nessuna modifica a tabelle esistenti.

create or replace function public.get_match_timeline(p_token text, p_game text)
returns table(played_at timestamptz, result text, deck_name text, opponent_label text, opponent_deck text, is_team_match boolean)
language plpgsql security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token);
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  if p_game not in ('yugioh','onepiece') then raise exception 'Gioco non valido'; end if;
  return query select m.played_at, m.result, d.name, m.opponent_label, m.opponent_deck, (m.opponent_member_slug is not null)
  from public.matches m
  join public.decks d on d.id = m.deck_id
  where m.member_slug = me and m.game = p_game
  order by m.played_at asc;
end;
$$;

revoke all on function public.get_match_timeline(text,text) from public, anon, authenticated;
grant execute on function public.get_match_timeline(text,text) to anon, authenticated;

notify pgrst, 'reload schema';

-- Rollback:
-- drop function if exists public.get_match_timeline(text,text);
-- notify pgrst, 'reload schema';
