-- F.P.T Cards — Milestone 14: avatar segreti sbloccati battendo un compagno
-- di squadra specifico N volte (sfida "rivale"), a prescindere dal gioco.
-- Migrazione additiva: eseguire dopo supabase-milestone-9-cosmetics.sql e
-- supabase-milestone-8-opponent-quick-deck.sql (serve matches.opponent_member_slug).
--
-- Sola lettura: conta le vittorie registrate contro ogni compagno, su tutti
-- i match mai giocati (yugioh+onepiece insieme) — il catalogo cosmetici
-- lato client (js/cosmetics.js) decide quale conteggio sblocca cosa.

create or replace function public.get_rival_wins(p_token text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token); result jsonb;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  select coalesce(jsonb_object_agg(wins.opponent_member_slug, wins.total), '{}'::jsonb) into result
  from (
    select opponent_member_slug, count(*) as total
    from public.matches
    where member_slug = me and result = 'win' and opponent_member_slug is not null
    group by opponent_member_slug
  ) wins;
  return coalesce(result, '{}'::jsonb);
end;
$$;

revoke all on function public.get_rival_wins(text) from public, anon, authenticated;
grant execute on function public.get_rival_wins(text) to anon, authenticated;

notify pgrst, 'reload schema';
