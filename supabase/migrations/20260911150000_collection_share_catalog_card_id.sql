-- F.P.T Cards — Shared Collection guest: aggiunge catalogCardId a ogni item
-- restituito da get_collection_share(). Serve solo per risolvere il tipo
-- YGOPRODeck (Spell/Trap/Fusion/...) lato client e mostrare lo sfondo per
-- tipo dietro l'immagine di ogni carta nella griglia guest — non è dato
-- sensibile (stessa categoria di cardName/rarity/setCode già esposti, vedi
-- il commento sicurezza in supabase-collection-share-guest-redesign.sql).
-- Nessun cambio di firma, nessun cambio di grant: create or replace basta.

create or replace function public.get_collection_share(p_share_id uuid)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare share public.collection_shares; owner_name text; items jsonb; card_count integer; printing_count integer;
begin
  select * into share from public.collection_shares where id = p_share_id and revoked_at is null;
  if not found then raise exception 'Link non valido o revocato'; end if;
  select full_name into owner_name from public.team_members where slug = share.owner_slug;

  select
    coalesce(jsonb_agg(jsonb_build_object(
      'printingId', row.printing_id, 'catalogCardId', row.catalog_card_id,
      'cardName', row.card_name, 'setCode', row.set_code, 'setName', row.set_name,
      'rarity', row.rarity, 'imageUrl', row.image_url,
      'quantityOwned', row.quantity_owned, 'quantityAvailable', row.quantity_available,
      'edition', row.edition, 'condition', row.condition, 'language', row.language,
      'alternateNames', coalesce(row.alt_names, '[]'::jsonb)
    ) order by row.card_name), '[]'::jsonb),
    count(distinct row.printing_id), count(distinct row.catalog_card_id)
  into items, printing_count, card_count
  from (
    select
      p.id printing_id, p.card_name, p.set_code, p.set_name, p.rarity, p.image_url, p.catalog_card_id,
      sum(ci.quantity_owned)::integer quantity_owned,
      sum(greatest(ci.quantity_owned
        - public.collection_item_loaned(ci.id) - public.collection_item_reserved(ci.id), 0))::integer quantity_available,
      case when count(distinct nullif(trim(ci.edition), '')) = 1 then min(nullif(trim(ci.edition), '')) end edition,
      case when count(distinct ci.condition) = 1 then min(ci.condition) end condition,
      case when count(distinct ci.language) = 1 then min(ci.language) end language,
      alt.names alt_names
    from public.collection_items ci
    join public.card_printings p on p.id = ci.printing_id
    left join lateral (
      select jsonb_agg(distinct other.card_name) as names
      from public.card_printings other
      where other.game = p.game and other.catalog_card_id = p.catalog_card_id
        and lower(trim(other.card_name)) <> lower(trim(p.card_name))
    ) alt on true
    where ci.owner_slug = share.owner_slug and p.game = share.game
    group by p.id, p.card_name, p.set_code, p.set_name, p.rarity, p.image_url, p.catalog_card_id, alt.names
  ) row;

  return jsonb_build_object(
    'ownerName', coalesce(owner_name,'Un membro del team'), 'game', share.game, 'items', items,
    'cardCount', coalesce(card_count, 0), 'printingCount', coalesce(printing_count, 0)
  );
end;
$$;

notify pgrst, 'reload schema';
