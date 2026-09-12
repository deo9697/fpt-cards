-- F.P.T Cards — repair_collection_item_catalog_identity: colonna ambigua.
--
-- Bug scoperto durante la verifica in produzione del fix del 2026-09-12
-- (throttle della coda di verifica catalogo): con la coda finalmente
-- limitata a un batch piccolo, i 400 su repair_collection_item_catalog_identity
-- NON sparivano — restava un errore Postgres genuino, non un problema di
-- volume: "column reference \"image_url\" is ambiguous" (sqlstate 42702).
--
-- Causa: la funzione dichiara RETURNS TABLE(..., image_url text, ...). In
-- PL/pgSQL le colonne di un RETURNS TABLE diventano variabili implicite
-- visibili in TUTTO il corpo della funzione. Due dei tre rami che aggiornano
-- card_printings referenziano printing_mapping_status/image_url SENZA
-- qualificarli (introdotti per proteggere le printing già 'verified'/
-- 'resolved' dal Printing Registry da un repair legacy che le sovrascrive —
-- vedi supabase/migrations/20260910224000_onepiece_image_cross_code_repair.sql
-- e 20260911160000_ygo_printing_registry.sql): per Postgres, il riferimento
-- e' ambiguo tra la variabile di output "image_url" e la colonna
-- card_printings.image_url. Il terzo ramo (INSERT ... ON CONFLICT DO UPDATE)
-- era già scritto qualificando esplicitamente (public.card_printings.image_url)
-- e infatti quello non ha mai generato l'errore.
--
-- Effetto pratico prima di questo fix: OGNI repair che cadeva nei due rami
-- UPDATE falliva con questo errore — cioè il caso più comune (canonical_id
-- già corretto, o già risolto verso una printing canonica esistente), non
-- solo i record realmente legacy/irrisolvibili. La coda quindi non riusciva
-- MAI a verificare nulla per questa via, anche con dati perfettamente
-- corretti, e ogni fallimento consumava comunque un tentativo (backoff)
-- della nuova record_collection_catalog_verification_attempt.
--
-- Fix: qualifica esplicita (card_printings.colonna) nei due rami UPDATE,
-- stesso pattern già in uso nel ramo ON CONFLICT. Nessun'altra riga cambiata:
-- stessa logica, stesse validazioni, stessa sicurezza (SECURITY DEFINER,
-- ownership, controlli one-piece/yugioh invariati).

begin;

create or replace function public.repair_collection_item_catalog_identity(
  p_token text, p_collection_item_id uuid, p_catalog_card_id text,
  p_card_name text, p_image_url text, p_verification_version integer
) returns table(
  collection_item_id uuid, printing_id uuid, catalog_card_id text,
  card_name text, image_url text, verification_status text,
  verification_version integer
) language plpgsql security definer set search_path = public, extensions as $$
declare
  me text := public.session_member(p_token);
  inventory public.collection_items;
  current_printing public.card_printings;
  target_printing_id uuid;
  canonical_id text;
  canonical_base text;
  image_id text;
  image_stem text;
  image_code text;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  if p_verification_version <> 1
    or char_length(trim(coalesce(p_catalog_card_id,''))) not between 1 and 100
    or char_length(trim(coalesce(p_card_name,''))) not between 1 and 200
    or coalesce(p_image_url,'') not like 'https://%'
    or char_length(coalesce(p_image_url,'')) > 500 then
    raise exception 'Dati verifica catalogo non validi';
  end if;

  select * into inventory from public.collection_items
    where id = p_collection_item_id for update;
  if not found or inventory.owner_slug <> me then
    raise exception 'Elemento raccolta non trovato o non modificabile';
  end if;
  select * into current_printing from public.card_printings
    where id = inventory.printing_id for update;
  if not found then raise exception 'Printing non trovata'; end if;

  canonical_id := public.resolve_catalog_card_id(current_printing.game, p_catalog_card_id);
  if current_printing.game = 'yugioh' then
    image_id := substring(p_image_url from '/([0-9]{5,10})\.(?:jpg|jpeg|png|webp)(?:[?#].*)?$');
    if image_id is not null
      and public.resolve_catalog_card_id(current_printing.game, image_id) <> canonical_id then
      raise exception 'Immagine e catalog ID non coerenti';
    end if;
  elsif current_printing.game = 'onepiece' then
    image_stem := regexp_replace(regexp_replace(p_image_url, '^.*/', ''), '\.(jpe?g|png|webp|gif)$', '', 'i');
    image_code := substring(image_stem from '^(([A-Za-z]{1,4}[0-9]{0,3}-[0-9]{1,4})|([Dd][Oo][Nn][_-]?[0-9]+))');
    if image_code is not null then
      image_code := regexp_replace(upper(image_code), '^DON-', 'DON_');
      canonical_base := substring(canonical_id from '^(([A-Za-z]{1,4}[0-9]{0,3}-[0-9]{1,4})|([Dd][Oo][Nn][_-]?[0-9]+))');
      canonical_base := coalesce(regexp_replace(upper(canonical_base), '^DON-', 'DON_'), upper(canonical_id));
      if image_code <> canonical_base then
        raise exception 'Immagine e catalog ID non coerenti';
      end if;
    end if;
  end if;

  if canonical_id = current_printing.catalog_card_id then
    target_printing_id := current_printing.id;
    update public.card_printings set
      image_url = case
        when card_printings.printing_mapping_status in ('verified', 'resolved') then card_printings.image_url
        else left(p_image_url,500)
      end,
      catalog_verification_status = 'verified',
      catalog_verification_version = p_verification_version,
      catalog_verified_at = now(),
      catalog_verification_error = null,
      updated_at = now()
    where id = target_printing_id;
  else
    select cp.id into target_printing_id
    from public.card_printings cp
    where cp.game = current_printing.game
      and cp.catalog_card_id = canonical_id
      and cp.set_code = current_printing.set_code
      and cp.rarity = current_printing.rarity
    for update;

    if target_printing_id is null then
      -- L'upsert rende atomiche due repair concorrenti dirette alla stessa
      -- printing canonica, senza creare duplicati o perdere il risultato.
      insert into public.card_printings(
        game, catalog_card_id, card_name, set_code, set_name, rarity, image_url,
        catalog_verification_status, catalog_verification_version,
        catalog_verified_at, catalog_verification_error
      ) values (
        current_printing.game, canonical_id, trim(p_card_name),
        current_printing.set_code, current_printing.set_name, current_printing.rarity,
        left(p_image_url,500), 'verified', p_verification_version, now(), null
      )
      on conflict (game, catalog_card_id, set_code, rarity) do update set
        image_url = case
          when public.card_printings.printing_mapping_status in ('verified', 'resolved') then public.card_printings.image_url
          else excluded.image_url
        end,
        catalog_verification_status = excluded.catalog_verification_status,
        catalog_verification_version = excluded.catalog_verification_version,
        catalog_verified_at = excluded.catalog_verified_at,
        catalog_verification_error = null,
        updated_at = now()
      returning id into target_printing_id;
    else
      update public.card_printings set
        image_url = case
          when card_printings.printing_mapping_status in ('verified', 'resolved') then card_printings.image_url
          else left(p_image_url,500)
        end,
        catalog_verification_status = 'verified',
        catalog_verification_version = p_verification_version,
        catalog_verified_at = now(),
        catalog_verification_error = null,
        updated_at = now()
      where id = target_printing_id;
    end if;

    if exists (
      select 1 from public.collection_items ci
      where ci.id <> inventory.id and ci.owner_slug = inventory.owner_slug
        and ci.printing_id = target_printing_id and ci.language = inventory.language
        and ci.condition = inventory.condition and ci.edition = inventory.edition
    ) then
      raise exception 'Repair bloccata: la printing canonica esiste gia nello stesso inventario';
    end if;

    -- Unica modifica ammessa all'inventario: il riferimento alla printing canonica.
    update public.collection_items set printing_id = target_printing_id
      where id = inventory.id;
  end if;

  return query select ci.id, cp.id, cp.catalog_card_id, cp.card_name, cp.image_url,
    cp.catalog_verification_status, cp.catalog_verification_version
  from public.collection_items ci
  join public.card_printings cp on cp.id = ci.printing_id
  where ci.id = inventory.id;
end;
$$;

revoke all on function public.repair_collection_item_catalog_identity(text,uuid,text,text,text,integer)
  from public, anon, authenticated;
grant execute on function public.repair_collection_item_catalog_identity(text,uuid,text,text,text,integer)
  to anon, authenticated;

notify pgrst, 'reload schema';

commit;
