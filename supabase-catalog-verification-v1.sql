-- F.P.T Cards - catalog verification v1.
-- Migration additiva preparata: NON applicare automaticamente al Supabase reale.

begin;

-- Alias legacy rilevato nei mazzi esistenti: l'inventario canonico usa 73642297.
insert into public.card_catalog_aliases(
  game, alias_catalog_card_id, canonical_catalog_card_id, source
) values (
  'yugioh', '73642296', '73642297', 'FPT legacy Ghost Belle identity'
)
on conflict (game, alias_catalog_card_id) do nothing;

do $$
begin
  if exists (
    select 1 from public.card_catalog_aliases
    where game = 'yugioh' and alias_catalog_card_id = '73642296'
      and canonical_catalog_card_id <> '73642297'
  ) then
    raise exception 'Alias Ghost Belle gia associato a una identita differente';
  end if;
end $$;

alter table public.card_printings
  add column if not exists catalog_verification_status text not null default 'pending',
  add column if not exists catalog_verification_version integer not null default 0,
  add column if not exists catalog_verified_at timestamptz,
  add column if not exists catalog_verification_error text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'card_printings_catalog_verification_status_check'
      and conrelid = 'public.card_printings'::regclass
  ) then
    alter table public.card_printings add constraint card_printings_catalog_verification_status_check
      check (catalog_verification_status in ('pending','verified','incoherent'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'card_printings_catalog_verification_version_check'
      and conrelid = 'public.card_printings'::regclass
  ) then
    alter table public.card_printings add constraint card_printings_catalog_verification_version_check
      check (catalog_verification_version >= 0);
  end if;
end $$;

-- Non parziale: deve servire anche la futura invalidazione di righe verified
-- quando la versione corrente del resolver viene incrementata.
drop index if exists public.card_printings_catalog_verification_queue_idx;
create index card_printings_catalog_verification_queue_idx
  on public.card_printings(catalog_verification_status, catalog_verification_version);

-- Baseline controllata: questi record sono gia passati dai resolver severi esistenti.
-- Le righe incomplete restano pending e saranno le sole a richiedere il provider.
update public.card_printings
set catalog_verification_status = 'verified',
    catalog_verification_version = 1,
    catalog_verified_at = coalesce(catalog_verified_at, updated_at, now()),
    catalog_verification_error = null
where catalog_verification_version = 0
  and char_length(trim(catalog_card_id)) between 1 and 100
  and char_length(trim(card_name)) between 1 and 200
  and image_url like 'https://%';

create or replace function public.invalidate_card_printing_catalog_verification()
returns trigger language plpgsql set search_path = public as $$
begin
  if (new.catalog_card_id, new.card_name, new.image_url)
      is distinct from (old.catalog_card_id, old.card_name, old.image_url)
    and new.catalog_verified_at is not distinct from old.catalog_verified_at
    and new.catalog_verification_version = old.catalog_verification_version then
    new.catalog_verification_status := 'pending';
    new.catalog_verification_version := 0;
    new.catalog_verified_at := null;
    new.catalog_verification_error := null;
  end if;
  return new;
end;
$$;

revoke all on function public.invalidate_card_printing_catalog_verification() from public, anon, authenticated;

drop trigger if exists invalidate_card_printing_catalog_verification_on_change on public.card_printings;
create trigger invalidate_card_printing_catalog_verification_on_change
before update of catalog_card_id, card_name, image_url on public.card_printings
for each row execute function public.invalidate_card_printing_catalog_verification();

create or replace function public.list_collection_catalog_verification_queue(
  p_token text, p_verification_version integer
) returns table(
  collection_item_id uuid, printing_id uuid, game text, catalog_card_id text,
  card_name text, set_code text, set_name text, rarity text, image_url text,
  verification_status text, verification_version integer
) language plpgsql stable security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token);
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  if p_verification_version <> 1 then raise exception 'Versione verifica non supportata'; end if;
  return query
    select ci.id, cp.id, cp.game, cp.catalog_card_id, cp.card_name,
      cp.set_code, cp.set_name, cp.rarity, cp.image_url,
      cp.catalog_verification_status, cp.catalog_verification_version
    from public.collection_items ci
    join public.card_printings cp on cp.id = ci.printing_id
    where ci.owner_slug = me and (
      cp.catalog_verification_status <> 'verified'
      or cp.catalog_verification_version < p_verification_version
      or char_length(trim(cp.catalog_card_id)) < 1
      or char_length(trim(cp.card_name)) < 1
      or cp.image_url not like 'https://%'
    )
    order by cp.updated_at, ci.id;
end;
$$;

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
  image_id text;
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
  end if;

  if canonical_id = current_printing.catalog_card_id then
    target_printing_id := current_printing.id;
    update public.card_printings set
      image_url = left(p_image_url,500),
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
        image_url = excluded.image_url,
        catalog_verification_status = excluded.catalog_verification_status,
        catalog_verification_version = excluded.catalog_verification_version,
        catalog_verified_at = excluded.catalog_verified_at,
        catalog_verification_error = null,
        updated_at = now()
      returning id into target_printing_id;
    else
      update public.card_printings set
        image_url = left(p_image_url,500),
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

revoke all on function public.list_collection_catalog_verification_queue(text,integer),
  public.repair_collection_item_catalog_identity(text,uuid,text,text,text,integer)
  from public, anon, authenticated;
grant execute on function public.list_collection_catalog_verification_queue(text,integer),
  public.repair_collection_item_catalog_identity(text,uuid,text,text,text,integer)
  to anon, authenticated;

notify pgrst, 'reload schema';

commit;
