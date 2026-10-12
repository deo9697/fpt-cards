-- F.P.T Cards — Cascata del tastierino PIN: carte della raccolta F.P.T.
--
-- Lo sfondo del tastierino del login (pagina pubblica) fa scendere le carte
-- della raccolta del team. Questa RPC, chiamabile da anon, restituisce SOLO
-- codici carta Yu-Gi-Oh! (il passcode numerico, usato per le miniature di
-- YGOPRODeck): niente proprietari, quantità, rarità o id interni, solo
-- membri attivi del team core F.P.T. (mai i team della beta).
--
-- La raccolta conta migliaia di carte: ne esce un sottoinsieme che cambia
-- ogni giorno ma resta stabile nella giornata, così il browser riusa le
-- immagini già scaricate. Massimo 60.
-- Richiede 20261012140000_beta_teams (core_team_id, team_members.team_id).

begin;

create or replace function public.list_login_cascade(p_limit integer default 30)
returns table(catalog_card_id text)
language sql stable security definer set search_path = public as $$
  select ids.catalog_card_id
  from (
    select distinct p.catalog_card_id
    from public.collection_items ci
    join public.team_members m on m.slug = ci.owner_slug and m.active and m.team_id = public.core_team_id()
    join public.card_printings p on p.id = ci.printing_id
    where p.game = 'yugioh' and ci.quantity_owned > 0 and p.catalog_card_id ~ '^[0-9]{4,10}$'
  ) ids
  order by md5(ids.catalog_card_id || current_date::text)
  limit least(greatest(coalesce(p_limit, 30), 1), 60)
$$;

revoke all on function public.list_login_cascade(integer) from public;
grant execute on function public.list_login_cascade(integer) to anon, authenticated;

notify pgrst, 'reload schema';

commit;
