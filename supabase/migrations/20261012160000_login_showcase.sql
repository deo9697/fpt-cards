-- F.P.T Cards — Vetrina del login: le carte più rare della raccolta F.P.T.
--
-- La pagina di accesso è pubblica (prima del login), quindi questa RPC è
-- chiamabile da anon e restituisce SOLO dati da vetrina: nome, rarità, codice
-- del set, immagine e quante copie ne ha il team. Mai chi le possiede, mai
-- id interni, mai le raccolte dei team della beta (solo membri attivi del
-- team core F.P.T.). Solo Yu-Gi-Oh! e solo immagini http(s).
--
-- Ordine: rarità più pregiata prima (Starlight / Quarter Century in cima),
-- poi le più diffuse nel team. Una riga per carta+rarità.
-- Richiede 20261012140000_beta_teams (core_team_id, team_members.team_id).

begin;

create or replace function public.list_login_showcase(p_limit integer default 6)
returns table(card_name text, rarity text, set_code text, image_url text, copies integer)
language sql stable security definer set search_path = public as $$
  with tiers(rarity, weight) as (values
    ('Quarter Century Secret Rare', 10), ('Starlight Rare', 10),
    ('Ghost Rare', 9), ('Ghost/Gold Rare', 9),
    ('Collector''s Rare', 8), ('Prismatic Secret Rare', 8), ('Prismatic Collector''s Rare', 8), ('Prismatic Ultimate Rare', 8),
    ('Platinum Secret Rare', 7), ('Ultimate Rare', 7),
    ('Gold Secret Rare', 6), ('Premium Gold Rare', 6),
    ('Secret Rare', 5), ('Ultra Rare', 3)
  ), owned as (
    select p.catalog_card_id, p.card_name, p.rarity, p.set_code, p.image_url, ci.quantity_owned, t.weight
    from public.collection_items ci
    join public.team_members m on m.slug = ci.owner_slug and m.active and m.team_id = public.core_team_id()
    join public.card_printings p on p.id = ci.printing_id
    join tiers t on t.rarity = p.rarity
    where p.game = 'yugioh' and ci.quantity_owned > 0 and p.image_url ~ '^https?://'
  ), grouped as (
    select catalog_card_id, rarity, max(weight) weight, sum(quantity_owned)::integer copies,
      (array_agg(card_name order by quantity_owned desc))[1] card_name,
      (array_agg(set_code order by quantity_owned desc))[1] set_code,
      (array_agg(image_url order by quantity_owned desc))[1] image_url
    from owned group by catalog_card_id, rarity
  )
  select card_name, rarity, set_code, image_url, copies
  from grouped
  order by weight desc, copies desc, card_name
  limit least(greatest(coalesce(p_limit, 6), 1), 12)
$$;

revoke all on function public.list_login_showcase(integer) from public;
grant execute on function public.list_login_showcase(integer) to anon, authenticated;

notify pgrst, 'reload schema';

commit;
