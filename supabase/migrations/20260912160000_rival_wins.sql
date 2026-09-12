-- F.P.T Cards — Milestone 14: avatar/titoli segreti "rivalità".
--
-- Scoperto durante il debug del repair storm del 2026-09-12: get_rival_wins
-- torna 404 a ogni bootstrap perché la funzione non è mai stata applicata al
-- progetto live (esisteva solo come file .sql sciolto in root, mai in
-- supabase/migrations/, quindi mai eseguita). Il client la chiama già con
-- Promise.allSettled + un secondo fallback try/catch{} (vedi js/stats.js),
-- quindi il 404 non è mai stato un crash — solo l'easter egg "rivalità"
-- (3 avatar/titoli segreti sbloccati battendo un compagno 5 volte, vedi
-- js/cosmetics.js) che non ha mai potuto attivarsi.
--
-- Additiva, sola lettura, nessuna scrittura: conta le vittorie per
-- avversario su tutti i match mai giocati (yugioh+onepiece insieme).
-- Dipendenza (matches.opponent_member_slug) verificata presente live prima
-- di applicare.
--
-- Bug trovato prima di applicare (stesso identico pattern del fix
-- repair_collection_item_catalog_identity di poco fa, vedi
-- 20260912150000_repair_catalog_identity_ambiguous_column_fix.sql): la
-- funzione dichiarava una variabile locale "result" che collide con la
-- colonna matches.result (l'esito 'win'/'loss'/'draw') usata bare nel WHERE
-- — "column reference \"result\" is ambiguous", riprodotto in una sessione
-- di test prima di applicare definitivamente. Rinominata la variabile in
-- "payload", nessun'altra modifica.

begin;

create or replace function public.get_rival_wins(p_token text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token); payload jsonb;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  select coalesce(jsonb_object_agg(wins.opponent_member_slug, wins.total), '{}'::jsonb) into payload
  from (
    select opponent_member_slug, count(*) as total
    from public.matches
    where member_slug = me and result = 'win' and opponent_member_slug is not null
    group by opponent_member_slug
  ) wins;
  return coalesce(payload, '{}'::jsonb);
end;
$$;

revoke all on function public.get_rival_wins(text) from public, anon, authenticated;
grant execute on function public.get_rival_wins(text) to anon, authenticated;

notify pgrst, 'reload schema';

commit;
