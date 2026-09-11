-- F.P.T Cards — striscia di vittorie CONSECUTIVE per un mazzo specifico
-- (non per gioco come get_match_streak, supabase-milestone-6-add-streak.sql).
-- Serve ai nuovi Deck Box sbloccabili per archetipo (Sacred Beast Orcust,
-- Mitsurugi, Skystriker, richiesti dall'utente 2026-09-11): 10 vittorie
-- consecutive con un mazzo di composizione X — il client verifica la
-- composizione (js/deck-archetype-unlocks.js) e chiama questa RPC solo per
-- sapere la lunghezza della striscia di vittorie su quel deck_id.
-- Migrazione additiva: NON applicata automaticamente al Supabase reale.
--
-- Stessa tecnica "gaps and islands" di get_match_streak, filtrata su
-- deck_id invece che game — a differenza di quella, qui interessa solo "la
-- striscia più recente è una serie di vittorie lunga almeno N", quindi
-- ritorna direttamente un intero (0 se il match più recente con questo
-- mazzo non è una vittoria, o se il mazzo non ha ancora match registrati).
--
-- Limite accettato consapevolmente (vedi piano): matches.deck_id punta al
-- mazzo CORRENTE, non c'è uno snapshot della composizione al momento di
-- ogni vittoria — la striscia conta i match storici collegati a quel
-- deck_id, ma la verifica "il mazzo rispetta la composizione richiesta" la
-- fa il client sullo stato ATTUALE del mazzo, non su come era ad ogni
-- singola vittoria passata. Stessa imprecisione già accettata da tutto il
-- resto del sistema cosmetics (client-trust, claim_cosmetic non valida
-- nulla lato server, vedi supabase-milestone-9-cosmetics.sql).

create or replace function public.get_deck_win_streak(p_token text, p_deck_id uuid)
returns integer language plpgsql security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token); streak_result text; streak_count integer;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  with ordered as (
    select result, row_number() over (order by played_at desc, created_at desc) as rn
    from public.matches where member_slug = me and deck_id = p_deck_id
  ), grp as (
    select result, rn, rn - row_number() over (partition by result order by rn) as grp
    from ordered
  )
  select g.result, count(*) into streak_result, streak_count
  from grp g, (select result, grp from grp where rn = 1) top
  where g.result = top.result and g.grp = top.grp
  group by g.result;

  if streak_result is distinct from 'win' then return 0; end if;
  return coalesce(streak_count, 0);
end;
$$;

revoke all on function public.get_deck_win_streak(text,uuid) from public, anon, authenticated;
grant execute on function public.get_deck_win_streak(text,uuid) to anon, authenticated;

notify pgrst, 'reload schema';
