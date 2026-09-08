-- F.P.T Cards — One Piece Fase 4: RPC catalogo + metadata in Raccolta.
-- Migrazione additiva preparata: NON applicata automaticamente al Supabase
-- reale. Richiede che sia già stata eseguita
-- supabase/migrations/20260908190500_onepiece_deck_and_printing_foundation.sql
-- (serve variant_id/game_metadata su card_printings) e che il catalog sync
-- (supabase/functions/onepiece-catalog-sync) abbia già popolato righe
-- game='onepiece' — altrimenti questa RPC funziona ma restituisce sempre
-- zero risultati per One Piece.
--
-- Cosa fa:
--   1) search_onepiece_catalog(p_token, p_query, p_limit): nuova RPC, cerca
--      solo su game='onepiece', restituisce le PRINTING fisiche (una riga
--      per printing, non raggruppate) — il client raggruppa per
--      catalog_card_id in "carte logiche" con più varianti.
--   2) list_my_collection / list_team_collection: aggiungono variant_id e
--      game_metadata in coda alle colonne esistenti. Cambia la forma
--      dell'output (RETURNS TABLE), quindi qui usiamo DROP + CREATE invece
--      di CREATE OR REPLACE — evita di scoprire a runtime se Postgres
--      accetta un append di colonne in coda o no. La logica interna (le CTE
--      materialized per loan/reservation/ambiguità) resta identica, solo le
--      due colonne in più attraversano la pipeline.
--
-- Cosa NON tocca: save_collection_item/save_collection_batch (già pronte
-- dalla Fase 2), save_deck/save_deck_with_box, set_deck_card_printing,
-- correct_collection_item_printing/repair_collection_item_catalog_identity
-- (restano percorsi solo Yu-Gi-Oh — il client instrada One Piece sempre su
-- save_collection_item da questa fase in poi).

begin;

-- 1) search_onepiece_catalog -----------------------------------------------

create or replace function public.search_onepiece_catalog(
  p_token text, p_query text, p_limit integer default 60
) returns table(
  printing_id uuid, catalog_card_id text, variant_id text, card_name text,
  set_code text, set_name text, rarity text, image_url text, game_metadata jsonb
) language plpgsql stable security definer set search_path = public, extensions as $$
declare
  me text := public.session_member(p_token);
  needle text := trim(coalesce(p_query, ''));
  capped_limit integer := greatest(1, least(coalesce(p_limit, 60), 200));
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  -- Query troppo corta: nessun errore, semplicemente zero risultati (è la
  -- ricerca live mentre l'utente digita, non un endpoint da validare come
  -- lookup_card_printings_by_set_code).
  if char_length(needle) < 2 then return; end if;
  return query
    select p.id, p.catalog_card_id, p.variant_id, p.card_name, p.set_code,
      p.set_name, p.rarity, p.image_url, p.game_metadata
    from public.card_printings p
    where p.game = 'onepiece'
      and (p.card_name ilike '%' || needle || '%'
        or p.catalog_card_id ilike '%' || needle || '%'
        or p.set_code ilike '%' || needle || '%')
    order by p.card_name, p.catalog_card_id, p.set_code, p.rarity
    limit capped_limit;
end;
$$;

revoke all on function public.search_onepiece_catalog(text,text,integer) from public, anon, authenticated;
grant execute on function public.search_onepiece_catalog(text,text,integer) to anon, authenticated;

-- 2) list_my_collection / list_team_collection + variant_id/game_metadata --

drop function if exists public.list_my_collection(text);
drop function if exists public.list_team_collection(text);

create function public.list_my_collection(p_token text)
returns table(
  id uuid, printing_id uuid, owner_slug text, owner_name text, game text,
  catalog_card_id text, card_name text, set_code text, set_name text, rarity text,
  language text, condition text, edition text, image_url text,
  quantity_owned integer, quantity_loaned integer, quantity_reserved integer,
  quantity_physically_available integer, legacy_ambiguous boolean,
  created_at timestamptz, updated_at timestamptz,
  variant_id text, game_metadata jsonb
) language plpgsql security definer set search_path=public,extensions as $$
declare me text := public.session_member(p_token);
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  return query
  with inventory as materialized (
    select ci.*,p.game,p.catalog_card_id,p.card_name,p.set_code,p.set_name,p.rarity,p.image_url,
      p.variant_id,p.game_metadata,m.full_name
    from public.collection_items ci join public.card_printings p on p.id=ci.printing_id
    join public.team_members m on m.slug=ci.owner_slug where ci.owner_slug=me
  ), identity_counts as materialized (
    select source.id,source.owner_slug,source.game,source.catalog_card_id,lower(trim(source.card_name)) normalized_name,
      count(*) over(partition by source.owner_slug,source.game,source.catalog_card_id) catalog_count,
      count(*) over(partition by source.owner_slug,source.game,lower(trim(source.card_name))) name_count
    from inventory source
  ), commitments as materialized (
    select i.id,
      coalesce(sum(greatest(coalesce(l.accepted_quantity,l.quantity)-l.returned_quantity,0))
        filter(where l.status in ('active','return_pending') and (l.collection_item_id=i.id or
          (nullif(trim(l.card_external_id),'')=i.catalog_card_id and c.catalog_count=1) or
          (nullif(trim(l.card_external_id),'') is null and c.name_count=1))),0)::integer loaned,
      coalesce(sum(greatest(coalesce(l.accepted_quantity,l.quantity)-l.returned_quantity,0))
        filter(where l.status='reserved' and (l.collection_item_id=i.id or
          (nullif(trim(l.card_external_id),'')=i.catalog_card_id and c.catalog_count=1) or
          (nullif(trim(l.card_external_id),'') is null and c.name_count=1))),0)::integer reserved,
      coalesce(bool_or(l.collection_item_id is null and (
        (nullif(trim(l.card_external_id),'')=i.catalog_card_id and c.catalog_count>1) or
        (nullif(trim(l.card_external_id),'') is null and lower(trim(l.card_name))=lower(trim(i.card_name)) and c.name_count>1)
      )),false) legacy_ambiguous
    from inventory i join identity_counts c on c.id=i.id
    left join public.loans l on l.owner_slug=i.owner_slug and l.game=i.game
      and l.status in ('reserved','active','return_pending') and (
        l.collection_item_id=i.id or (l.collection_item_id is null and (
          nullif(trim(l.card_external_id),'')=i.catalog_card_id or
          (nullif(trim(l.card_external_id),'') is null and lower(trim(l.card_name))=lower(trim(i.card_name)))
        ))
      )
    group by i.id
  )
  select i.id,i.printing_id,i.owner_slug,i.full_name,i.game,i.catalog_card_id,i.card_name,
    i.set_code,i.set_name,i.rarity,i.language,i.condition,i.edition,i.image_url,i.quantity_owned,
    coalesce(c.loaned,0),coalesce(c.reserved,0),
    greatest(i.quantity_owned-coalesce(c.loaned,0)-coalesce(c.reserved,0),0),
    coalesce(c.legacy_ambiguous,false),i.created_at,i.updated_at,
    i.variant_id,i.game_metadata
  from inventory i left join commitments c on c.id=i.id
  order by i.card_name,i.set_code,i.condition;
end;
$$;

create function public.list_team_collection(p_token text)
returns table(
  id uuid, printing_id uuid, owner_slug text, owner_name text, game text,
  catalog_card_id text, card_name text, set_code text, set_name text, rarity text,
  language text, condition text, edition text, image_url text,
  quantity_loaned integer, quantity_reserved integer,
  quantity_physically_available integer, legacy_ambiguous boolean, updated_at timestamptz,
  variant_id text, game_metadata jsonb
) language plpgsql security definer set search_path=public,extensions as $$
declare me text := public.session_member(p_token);
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  return query
  with inventory as materialized (
    select ci.*,p.game,p.catalog_card_id,p.card_name,p.set_code,p.set_name,p.rarity,p.image_url,
      p.variant_id,p.game_metadata,m.full_name
    from public.collection_items ci join public.card_printings p on p.id=ci.printing_id
    join public.team_members m on m.slug=ci.owner_slug and m.active
  ), identity_counts as materialized (
    select source.id,source.owner_slug,source.game,source.catalog_card_id,lower(trim(source.card_name)) normalized_name,
      count(*) over(partition by source.owner_slug,source.game,source.catalog_card_id) catalog_count,
      count(*) over(partition by source.owner_slug,source.game,lower(trim(source.card_name))) name_count
    from inventory source
  ), commitments as materialized (
    select i.id,
      coalesce(sum(greatest(coalesce(l.accepted_quantity,l.quantity)-l.returned_quantity,0))
        filter(where l.status in ('active','return_pending') and (l.collection_item_id=i.id or
          (nullif(trim(l.card_external_id),'')=i.catalog_card_id and c.catalog_count=1) or
          (nullif(trim(l.card_external_id),'') is null and c.name_count=1))),0)::integer loaned,
      coalesce(sum(greatest(coalesce(l.accepted_quantity,l.quantity)-l.returned_quantity,0))
        filter(where l.status='reserved' and (l.collection_item_id=i.id or
          (nullif(trim(l.card_external_id),'')=i.catalog_card_id and c.catalog_count=1) or
          (nullif(trim(l.card_external_id),'') is null and c.name_count=1))),0)::integer reserved,
      coalesce(bool_or(l.collection_item_id is null and (
        (nullif(trim(l.card_external_id),'')=i.catalog_card_id and c.catalog_count>1) or
        (nullif(trim(l.card_external_id),'') is null and lower(trim(l.card_name))=lower(trim(i.card_name)) and c.name_count>1)
      )),false) legacy_ambiguous
    from inventory i join identity_counts c on c.id=i.id
    left join public.loans l on l.owner_slug=i.owner_slug and l.game=i.game
      and l.status in ('reserved','active','return_pending') and (
        l.collection_item_id=i.id or (l.collection_item_id is null and (
          nullif(trim(l.card_external_id),'')=i.catalog_card_id or
          (nullif(trim(l.card_external_id),'') is null and lower(trim(l.card_name))=lower(trim(i.card_name)))
        ))
      )
    group by i.id
  )
  select i.id,i.printing_id,i.owner_slug,i.full_name,i.game,i.catalog_card_id,i.card_name,
    i.set_code,i.set_name,i.rarity,i.language,i.condition,i.edition,i.image_url,
    coalesce(c.loaned,0),coalesce(c.reserved,0),
    greatest(i.quantity_owned-coalesce(c.loaned,0)-coalesce(c.reserved,0),0),
    coalesce(c.legacy_ambiguous,false),i.updated_at,
    i.variant_id,i.game_metadata
  from inventory i left join commitments c on c.id=i.id
  order by i.card_name,i.full_name,i.set_code;
end;
$$;

revoke all on function public.list_my_collection(text), public.list_team_collection(text) from public, anon, authenticated;
grant execute on function public.list_my_collection(text), public.list_team_collection(text) to anon, authenticated;

notify pgrst, 'reload schema';

commit;
