-- F.P.T Cards — mostra anche il titolo equipaggiato (non solo l'avatar) di
-- OGNI membro nella sezione Team, e corregge il titolo del membro corrente
-- che non compariva né in Statistiche né nella topbar dopo averlo
-- equipaggiato (bug lato client: leggevano sempre titleForLevel() invece
-- di cosmetics.activeTitle, fix separato in app.js/js/stats.js).
--
-- Stesso motivo di supabase-milestone-13-team-member-avatars.sql:
-- member_progression.active_title/level non sono dati privati, sono pensati
-- per essere visibili al team (member_cosmetic_unlocks è "davvero"
-- server-validated per lo stesso motivo).
--
-- Rinominata da list_member_avatars a list_member_profiles perché il return
-- type cambia (aggiunge active_title e level, serve lato client come
-- fallback quando un membro non ha ancora equipaggiato un titolo custom) —
-- un CREATE OR REPLACE non può cambiare il return type di una funzione
-- esistente, va droppata la vecchia esplicitamente.

create or replace function public.list_member_profiles(p_token text)
returns table(member_slug text, active_avatar text, active_title text, level integer)
language plpgsql security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token);
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  return query select mp.member_slug, coalesce(mp.active_avatar, ''), coalesce(mp.active_title, ''), mp.level
  from public.member_progression mp
  join public.team_members tm on tm.slug = mp.member_slug and tm.active;
end;
$$;

revoke all on function public.list_member_profiles(text) from public, anon, authenticated;
grant execute on function public.list_member_profiles(text) to anon, authenticated;

drop function if exists public.list_member_avatars(text);

notify pgrst, 'reload schema';
