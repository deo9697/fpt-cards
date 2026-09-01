-- F.P.T Cards — P0.4 Printing Editor Integrity.
-- Correzione additiva e field-specific di rarity/edition per un collection item.

begin;

create or replace function public.correct_collection_item_printing(
  p_token text,
  p_collection_item_id uuid,
  p_catalog_card_id text,
  p_card_name text,
  p_set_code text,
  p_set_name text,
  p_rarity text,
  p_image_url text,
  p_edition text,
  p_verification_version integer
) returns table(
  collection_item_id uuid,
  printing_id uuid,
  catalog_card_id text,
  card_name text,
  set_code text,
  set_name text,
  rarity text,
  edition text,
  quantity_owned integer,
  language text,
  condition text
) language plpgsql
security definer
set search_path = ''
as $$
declare
  me text := public.session_member(p_token);
  inventory public.collection_items;
  current_printing public.card_printings;
  target_printing_id uuid;
  canonical_id text;
  current_canonical_id text;
  desired_set_code text := upper(trim(coalesce(p_set_code,'')));
  desired_rarity text := trim(coalesce(p_rarity,''));
  desired_edition text := trim(coalesce(p_edition,''));
  reconciliation text;
  committed integer;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  if p_verification_version <> 1 then raise exception 'Versione verifica catalogo non supportata'; end if;
  if char_length(trim(coalesce(p_catalog_card_id,''))) not between 1 and 100
    or char_length(trim(coalesce(p_card_name,''))) not between 1 and 200
    or char_length(desired_set_code) not between 1 and 100
    or char_length(desired_rarity) not between 1 and 100
    or char_length(trim(coalesce(p_set_name,''))) > 200
    or coalesce(p_image_url,'') not like 'https://%'
    or char_length(coalesce(p_image_url,'')) > 500 then
    raise exception 'Dati printing verificata non validi';
  end if;

  select * into inventory
  from public.collection_items
  where id = p_collection_item_id
  for update;
  if not found or inventory.owner_slug <> me then
    raise exception 'Elemento raccolta non trovato o non modificabile';
  end if;

  select * into current_printing
  from public.card_printings
  where id = inventory.printing_id
  for update;
  if not found then raise exception 'Printing corrente non trovata'; end if;

  canonical_id := public.resolve_catalog_card_id(current_printing.game, p_catalog_card_id);
  current_canonical_id := public.resolve_catalog_card_id(current_printing.game, current_printing.catalog_card_id);
  if canonical_id <> current_canonical_id then
    raise exception 'La correzione deve restare sulla stessa carta canonica';
  end if;

  reconciliation := public.reconcile_catalog_identity(
    current_printing.game, canonical_id, desired_set_code, p_card_name, p_image_url
  );
  if reconciliation = 'mismatch' then
    raise exception 'Dati catalogo incoerenti';
  end if;

  if desired_edition not in ('', 'Prima Edizione', 'Unlimited')
    and desired_edition <> inventory.edition then
    raise exception 'Edizione non valida';
  end if;

  select cp.id into target_printing_id
  from public.card_printings cp
  where cp.game = current_printing.game
    and cp.catalog_card_id = canonical_id
    and cp.set_code = desired_set_code
    and lower(trim(cp.rarity)) = lower(desired_rarity)
  for update;

  if target_printing_id is null then
    insert into public.card_printings(
      game, catalog_card_id, card_name, set_code, set_name, rarity, image_url,
      catalog_verification_status, catalog_verification_version,
      catalog_verified_at, catalog_verification_error
    ) values (
      current_printing.game, canonical_id, trim(p_card_name), desired_set_code,
      left(trim(coalesce(p_set_name,'')),200), desired_rarity, left(p_image_url,500),
      'verified', p_verification_version, now(), null
    )
    on conflict on constraint card_printings_game_catalog_card_id_set_code_rarity_key do nothing
    returning id into target_printing_id;

    if target_printing_id is null then
      select cp.id into target_printing_id
      from public.card_printings cp
      where cp.game = current_printing.game
        and cp.catalog_card_id = canonical_id
        and cp.set_code = desired_set_code
        and cp.rarity = desired_rarity
      for update;
    end if;
  end if;

  if target_printing_id is null then raise exception 'Creazione printing verificata non riuscita'; end if;

  committed := public.collection_item_loaned(inventory.id) + public.collection_item_reserved(inventory.id);
  if target_printing_id <> inventory.printing_id and committed > 0 then
    raise exception 'Non puoi cambiare printing mentre esiste un prestito collegato';
  end if;

  if exists (
    select 1 from public.collection_items ci
    where ci.owner_slug = inventory.owner_slug
      and ci.id <> inventory.id
      and ci.printing_id = target_printing_id
      and ci.language = inventory.language
      and ci.condition = inventory.condition
      and ci.edition = desired_edition
  ) then
    raise exception 'Esiste già un elemento con questa printing e gli stessi metadati';
  end if;

  -- Field-specific: UUID, owner, quantità, lingua e condizione non possono cambiare.
  update public.collection_items
  set printing_id = target_printing_id,
      edition = desired_edition
  where id = inventory.id;

  return query
  select ci.id, cp.id, cp.catalog_card_id, cp.card_name, cp.set_code, cp.set_name,
    cp.rarity, ci.edition, ci.quantity_owned, ci.language, ci.condition
  from public.collection_items ci
  join public.card_printings cp on cp.id = ci.printing_id
  where ci.id = inventory.id;
end;
$$;

comment on function public.correct_collection_item_printing(
  text,uuid,text,text,text,text,text,text,text,integer
) is 'Relinks one owned collection item to an exact verified printing and updates only its edition.';

revoke all on function public.correct_collection_item_printing(
  text,uuid,text,text,text,text,text,text,text,integer
) from public, anon, authenticated;
grant execute on function public.correct_collection_item_printing(
  text,uuid,text,text,text,text,text,text,text,integer
) to anon, authenticated;

notify pgrst, 'reload schema';

commit;
