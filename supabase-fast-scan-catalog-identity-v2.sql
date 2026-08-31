-- F.P.T Cards — Fast Scan catalog identity v2.
-- Migrazione additiva: separa l'identità canonica della carta dal suo artwork.

insert into public.card_catalog_aliases(
  game, alias_catalog_card_id, canonical_catalog_card_id, source
) values
  ('yugioh', '89631140', '89631139', 'YGOPRODeck alternate artwork'),
  ('yugioh', '89631141', '89631139', 'YGOPRODeck alternate artwork'),
  ('yugioh', '89631142', '89631139', 'YGOPRODeck alternate artwork'),
  ('yugioh', '89631143', '89631139', 'YGOPRODeck alternate artwork'),
  ('yugioh', '89631144', '89631139', 'YGOPRODeck alternate artwork'),
  ('yugioh', '89631145', '89631139', 'YGOPRODeck alternate artwork'),
  ('yugioh', '89631146', '89631139', 'YGOPRODeck alternate artwork')
on conflict (game, alias_catalog_card_id) do nothing;

do $$
begin
  if exists (
    select 1
    from public.card_catalog_aliases alias
    where alias.game = 'yugioh'
      and alias.alias_catalog_card_id in (
        '89631140','89631141','89631142','89631143',
        '89631144','89631145','89631146'
      )
      and alias.canonical_catalog_card_id <> '89631139'
  ) then
    raise exception 'Un artwork Blue-Eyes è già associato a una carta differente';
  end if;

  if exists (
    select 1
    from public.card_printings source_printing
    join public.card_catalog_aliases alias
      on alias.game = source_printing.game
     and alias.alias_catalog_card_id = source_printing.catalog_card_id
    join public.card_printings canonical_printing
      on canonical_printing.game = source_printing.game
     and canonical_printing.catalog_card_id = alias.canonical_catalog_card_id
     and canonical_printing.set_code = source_printing.set_code
     and canonical_printing.rarity = source_printing.rarity
     and canonical_printing.id <> source_printing.id
  ) then
    raise exception 'Canonicalizzazione catalogo bloccata: printing duplicate da riconciliare';
  end if;
end $$;

-- Mantiene gli UUID delle printing e tutti i riferimenti raccolta/prestiti.
update public.card_printings printing
set catalog_card_id = alias.canonical_catalog_card_id
from public.card_catalog_aliases alias
where alias.game = printing.game
  and alias.alias_catalog_card_id = printing.catalog_card_id;

create or replace function public.reconcile_catalog_identity(
  p_game text, p_catalog_card_id text, p_set_code text, p_card_name text,
  p_image_url text default ''
) returns text language plpgsql stable security definer set search_path = public as $$
declare
  canonical_id text;
  normalized_set_code text;
  known boolean;
  conflicting boolean;
  image_id text;
begin
  if p_game not in ('yugioh','onepiece')
    or char_length(trim(coalesce(p_catalog_card_id,''))) < 1
    or char_length(trim(coalesce(p_card_name,''))) < 1 then
    return 'mismatch';
  end if;

  canonical_id := public.resolve_catalog_card_id(p_game, p_catalog_card_id);
  normalized_set_code := upper(trim(coalesce(p_set_code,'')));

  select exists(
    select 1 from public.card_printings printing
    where printing.game = p_game
      and printing.catalog_card_id = canonical_id
  ) into known;

  -- Il nome non è un'identità globale: artwork diversi della stessa carta possono
  -- avere ID immagine differenti. Rimane bloccata una contraddizione sullo stesso
  -- ID canonico o sulla medesima printing fisica (set code).
  select exists(
    select 1 from public.card_printings printing
    where printing.game = p_game and (
      (printing.catalog_card_id = canonical_id
        and lower(trim(printing.card_name)) <> lower(trim(p_card_name)))
      or
      (normalized_set_code <> ''
        and upper(trim(printing.set_code)) = normalized_set_code
        and lower(trim(printing.card_name)) = lower(trim(p_card_name))
        and printing.catalog_card_id <> canonical_id)
    )
  ) into conflicting;

  if conflicting then return 'mismatch'; end if;

  if p_game = 'yugioh' and coalesce(p_image_url,'') <> '' then
    image_id := substring(
      p_image_url from '/([0-9]{5,10})\.(?:jpg|jpeg|png|webp)(?:[?#].*)?$'
    );
    if image_id is not null
      and public.resolve_catalog_card_id(p_game, image_id) <> canonical_id then
      return 'mismatch';
    end if;
  end if;

  return case when known then 'valid' else 'warning' end;
end;
$$;

revoke all on function public.reconcile_catalog_identity(text,text,text,text,text)
  from public, anon, authenticated;

notify pgrst, 'reload schema';
