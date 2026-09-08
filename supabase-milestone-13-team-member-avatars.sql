-- F.P.T Cards — Milestone 13: mostra l'avatar equipaggiato di OGNI membro
-- nella sezione Team, non solo del membro corrente (finora era una scelta
-- di scope esplicita per la V1 dei cosmetici, vedi commento in app.js
-- profileAvatarMarkup — l'avatar di un membro diverso da te non era mai
-- letto). Nessuna nuova tabella: member_progression.active_avatar esiste
-- già da supabase-milestone-9-cosmetics.sql ed è pensata per essere
-- visibile agli altri membri del team (stesso motivo per cui
-- member_cosmetic_unlocks è "davvero" server-validated: non è dato privato).
--
-- Sola lettura, nessuna scrittura: come le altre RPC del progetto, grant
-- sempre a `anon, authenticated` insieme.

create or replace function public.list_member_avatars(p_token text)
returns table(member_slug text, active_avatar text)
language plpgsql security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token);
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  return query select mp.member_slug, coalesce(mp.active_avatar, '')
  from public.member_progression mp
  join public.team_members tm on tm.slug = mp.member_slug and tm.active;
end;
$$;

revoke all on function public.list_member_avatars(text) from public, anon, authenticated;
grant execute on function public.list_member_avatars(text) to anon, authenticated;

notify pgrst, 'reload schema';

-- Rollback:
-- drop function if exists public.list_member_avatars(text);
-- notify pgrst, 'reload schema';
