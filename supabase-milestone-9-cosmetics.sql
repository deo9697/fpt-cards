-- F.P.T Cards — Milestone 9: sistema cosmetici (avatar/titoli sbloccabili
-- ed equipaggiabili). Migrazione additiva: eseguire dopo
-- supabase-milestone-6-statistics-progression.sql.
--
-- Design: il CATALOGO dei cosmetici (quali esistono, di che tipo, quale
-- condizione li sblocca) vive lato client in js/cosmetics.js, non qui —
-- niente `if (level >= 5) ...` sparso, un solo posto da aggiornare per
-- aggiungere nuovi cosmetici o nuovi tipi di sblocco (level/achievement/
-- daily/event/admin/special). Il server si limita a: (1) ricordare quali
-- cosmetic_id un membro ha già sbloccato (claim_cosmetic — il client calcola
-- la condizione con isCosmeticUnlocked() e chiama questo quando è vera; un
-- id inventato o richiesto in anticipo non fa danni, è pura estetica, non
-- economia/competizione), (2) impedire di EQUIPAGGIARE qualcosa che non
-- risulta sbloccato (equip_cosmetic controlla member_cosmetic_unlocks
-- davvero, quello sì visibile agli altri membri del team quindi validato
-- lato server).
--
-- Grant sempre a `anon, authenticated` insieme, mai `authenticated` da solo
-- (regola empirica del progetto, vedi commit supabase-collection-sharing-
-- grants-fix.sql/-fix2.sql — la versione authenticated-only non ha mai
-- funzionato qui).

alter table public.member_progression add column if not exists active_avatar text not null default '';

create table if not exists public.member_cosmetic_unlocks (
  member_slug text not null references public.team_members(slug) on delete cascade,
  cosmetic_id text not null check (char_length(cosmetic_id) between 1 and 60),
  unlocked_at timestamptz not null default now(),
  primary key (member_slug, cosmetic_id)
);
alter table public.member_cosmetic_unlocks enable row level security;
revoke all on public.member_cosmetic_unlocks from public, anon, authenticated;

create or replace function public.get_my_cosmetics(p_token text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token); v_active_title text; v_active_avatar text; unlocked jsonb;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  insert into public.member_progression(member_slug, total_xp, level) values (me, 0, 1) on conflict (member_slug) do nothing;
  select coalesce(active_title,''), coalesce(active_avatar,'') into v_active_title, v_active_avatar
    from public.member_progression where member_slug = me;
  select coalesce(jsonb_agg(cosmetic_id order by unlocked_at), '[]'::jsonb) into unlocked
    from public.member_cosmetic_unlocks where member_slug = me;
  return jsonb_build_object('activeTitle', v_active_title, 'activeAvatar', v_active_avatar, 'unlocked', unlocked);
end;
$$;

create or replace function public.claim_cosmetic(p_token text, p_cosmetic_id text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token);
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  if coalesce(trim(p_cosmetic_id),'') = '' then raise exception 'Cosmetic non valido'; end if;
  insert into public.member_cosmetic_unlocks(member_slug, cosmetic_id) values (me, trim(p_cosmetic_id))
    on conflict (member_slug, cosmetic_id) do nothing;
end;
$$;

create or replace function public.equip_cosmetic(p_token text, p_type text, p_cosmetic_id text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token); target text := coalesce(trim(p_cosmetic_id),'');
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  if p_type not in ('avatar','title') then raise exception 'Tipo cosmetic non valido'; end if;
  if target <> '' and not exists (
    select 1 from public.member_cosmetic_unlocks where member_slug = me and cosmetic_id = target
  ) then raise exception 'Cosmetic non sbloccato'; end if;
  insert into public.member_progression(member_slug, total_xp, level) values (me, 0, 1) on conflict (member_slug) do nothing;
  if p_type = 'avatar' then update public.member_progression set active_avatar = target where member_slug = me;
  else update public.member_progression set active_title = target where member_slug = me; end if;
end;
$$;

revoke all on function public.get_my_cosmetics(text), public.claim_cosmetic(text,text), public.equip_cosmetic(text,text,text)
  from public, anon, authenticated;
grant execute on function public.get_my_cosmetics(text), public.claim_cosmetic(text,text), public.equip_cosmetic(text,text,text)
  to anon, authenticated;

notify pgrst, 'reload schema';
