-- F.P.T Cards — Raccolta condivisa (guest): la ricerca non trova le carte
-- digitando il nome italiano quando la stampa posseduta ha il nome inglese
-- (card_name è sempre quello restituito da YGOPRODeck, quasi sempre inglese;
-- non esiste in nessun punto dell'app un dizionario di traduzione EN/IT).
-- Migrazione additiva: eseguire dopo supabase-collection-sharing.sql.
--
-- Non costruiamo un traduttore universale (stessa scelta già presa per Fast
-- Scan: niente Yugipedia, vedi supabase-fast-scan-catalog-aliases.sql) —
-- riusiamo invece un dato che il catalogo ha già: quando due stampe con lo
-- stesso catalog_card_id hanno nomi diversi (es. "Sintonizzare"/"Tuning",
-- stessa carta, prodotti diversi), get_collection_share ora restituisce
-- anche quei nomi alternativi per ogni item, così il client può far
-- corrispondere la ricerca a QUALSIASI nome noto per quella carta, non solo
-- a quello della copia posseduta. Cresce da sola man mano che il catalogo
-- accumula stampe con nomi in lingue diverse — non serve seminare nulla a
-- mano per usarla, ma copre solo le carte che hanno già un nome alternativo
-- registrato da qualche parte nel catalogo.

create or replace function public.get_collection_share(p_share_id uuid)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare share public.collection_shares; owner_name text; items jsonb;
begin
  select * into share from public.collection_shares where id = p_share_id and revoked_at is null;
  if not found then raise exception 'Link non valido o revocato'; end if;
  select full_name into owner_name from public.team_members where slug = share.owner_slug;
  select coalesce(jsonb_agg(jsonb_build_object(
    'printingId', p.id, 'cardName', p.card_name, 'setCode', p.set_code, 'setName', p.set_name,
    'rarity', p.rarity, 'imageUrl', p.image_url, 'quantityOwned', totals.quantity,
    'alternateNames', coalesce(alt.names, '[]'::jsonb)
  ) order by p.card_name), '[]'::jsonb) into items
  from (
    select ci.printing_id, sum(ci.quantity_owned)::integer quantity
    from public.collection_items ci join public.card_printings cp on cp.id = ci.printing_id
    where ci.owner_slug = share.owner_slug and cp.game = share.game
    group by ci.printing_id
  ) totals
  join public.card_printings p on p.id = totals.printing_id
  left join lateral (
    select jsonb_agg(distinct other.card_name) as names
    from public.card_printings other
    where other.game = p.game and other.catalog_card_id = p.catalog_card_id
      and lower(trim(other.card_name)) <> lower(trim(p.card_name))
  ) alt on true;
  return jsonb_build_object('ownerName', coalesce(owner_name,'Un membro del team'), 'game', share.game, 'items', items);
end;
$$;

notify pgrst, 'reload schema';
