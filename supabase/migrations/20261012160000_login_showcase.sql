-- F.P.T Cards — Vetrina del login: le carte di maggior valore della raccolta F.P.T.
--
-- La pagina di accesso è pubblica (prima del login), quindi questa RPC è
-- chiamabile da anon e restituisce SOLO dati da vetrina: nome, rarità, codice
-- del set, immagine, quante copie ne ha il team e il prezzo di riferimento.
-- Mai chi le possiede, mai id interni, mai le raccolte dei team della beta
-- (solo membri attivi del team core F.P.T.). Solo Yu-Gi-Oh! e solo immagini
-- http(s).
--
-- Prezzo: lo stesso riferimento di Market Watch (get_market_watch_summary):
-- snapshot correnti in EUR dei soli mapping attivi, tipo di prezzo scelto da
-- market_reference_type(). Ordine: prezzo più alto prima; una riga per
-- carta+rarità (le stampe in lingue diverse contano una volta). Se le carte con
-- prezzo non bastano, si riempie con le rarità più pregiate senza prezzo.
-- Richiede 20261012140000_beta_teams (core_team_id, team_members.team_id).

begin;

create or replace function public.list_login_showcase(p_limit integer default 6)
returns table(card_name text, rarity text, set_code text, image_url text, copies integer, price numeric)
language sql stable security definer set search_path = public as $$
  with owned as (
    select ci.printing_id, sum(ci.quantity_owned)::integer copies
    from public.collection_items ci
    join public.team_members m on m.slug = ci.owner_slug and m.active and m.team_id = public.core_team_id()
    where ci.quantity_owned > 0
    group by ci.printing_id
  ), flags as (
    select id, public.market_mapping_is_active(provider, resolution_status, provider_metadata) active
    from public.market_provider_printings
    where printing_id in (select printing_id from owned)
  ), preferred as (
    select distinct on (c.printing_id, c.provider) c.printing_id, c.provider, c.price_type, c.normalized_price
    from public.market_current_price_snapshots c
    join flags f on f.id = c.provider_mapping_id
    where f.active and c.normalized_price is not null and c.normalized_currency = 'EUR'
    order by c.printing_id, c.provider, public.market_reference_type(c.provider, c.price_type), c.captured_at desc
  ), reference as (
    select distinct on (printing_id) printing_id, normalized_price
    from preferred
    order by printing_id, public.market_reference_type(provider, price_type)
  ), tiers(rarity, weight) as (values
    ('Quarter Century Secret Rare', 10), ('Starlight Rare', 10), ('Ghost Rare', 9),
    ('Collector''s Rare', 8), ('Prismatic Secret Rare', 8), ('Platinum Secret Rare', 7),
    ('Ultimate Rare', 7), ('Gold Secret Rare', 6), ('Secret Rare', 5), ('Ultra Rare', 3)
  ), candidates as (
    select distinct on (p.catalog_card_id, p.rarity)
      p.card_name, p.rarity, p.set_code, p.image_url, o.copies, r.normalized_price price, coalesce(t.weight, 0) weight
    from owned o
    join public.card_printings p on p.id = o.printing_id
    left join reference r on r.printing_id = o.printing_id
    left join tiers t on t.rarity = p.rarity
    where p.game = 'yugioh' and p.image_url ~ '^https?://'
      and (r.normalized_price is not null or t.weight is not null)
    order by p.catalog_card_id, p.rarity, r.normalized_price desc nulls last, o.copies desc
  )
  select card_name, rarity, set_code, image_url, copies, round(price, 2)
  from candidates
  order by price desc nulls last, weight desc, copies desc, card_name
  limit least(greatest(coalesce(p_limit, 6), 1), 12)
$$;

revoke all on function public.list_login_showcase(integer) from public;
grant execute on function public.list_login_showcase(integer) to anon, authenticated;

notify pgrst, 'reload schema';

commit;
