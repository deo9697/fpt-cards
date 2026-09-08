-- Card identity is independent of translated names and artwork labels.
-- Keep printing UUIDs, quantities, uniqueness constraints and loan links intact.
create or replace function public.reconcile_catalog_identity(
  p_game text, p_catalog_card_id text, p_set_code text, p_card_name text,
  p_image_url text default ''
) returns text language plpgsql stable security definer set search_path = '' as $$
declare
  canonical_id text;
  normalized_set_code text;
  known boolean;
  image_id text;
begin
  if p_game is null or p_game not in ('yugioh','onepiece')
    or char_length(trim(coalesce(p_catalog_card_id,''))) < 1
    or char_length(trim(coalesce(p_card_name,''))) < 1 then
    return 'mismatch';
  end if;
  canonical_id := public.resolve_catalog_card_id(p_game, p_catalog_card_id);
  normalized_set_code := upper(trim(coalesce(p_set_code,'')));

  select exists(select 1 from public.card_printings printing
    where printing.game = p_game and printing.catalog_card_id = canonical_id)
  into known;

  -- The same physical set code cannot identify another canonical card,
  -- even if its name is translated. Known artwork aliases remain valid.
  if normalized_set_code <> '' and exists (
    select 1 from public.card_printings printing
    where printing.game = p_game
      and upper(trim(printing.set_code)) = normalized_set_code
      and public.resolve_catalog_card_id(p_game, printing.catalog_card_id) <> canonical_id
  ) then return 'mismatch'; end if;

  if p_game = 'yugioh' and coalesce(p_image_url,'') <> '' then
    image_id := substring(p_image_url from '/([0-9]{5,10})[.](?:jpg|jpeg|png|webp)(?:[?#].*)?$');
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
