-- Fix di list_catalog_printings_index (20260915100000): p.id > p_after_id
-- non è un cursore incrementale sicuro perché id è uuid e l'ordinamento
-- uuid non corrisponde all'ordine di inserimento — una pagina poteva saltare
-- o ripetere righe rispetto alla precedente. Firma RPC invariata (il client
-- Step B in js/fast-scan-catalog-cache.js la usa già così): si ordina e
-- pagina per (created_at, id), risolvendo p_after_id nel suo created_at per
-- restare compatibili con un cursore già salvato lato client.
create or replace function public.list_catalog_printings_index(
  p_token text, p_game text, p_after_id uuid default null, p_limit integer default 1000
) returns table(
  printing_id uuid, catalog_card_id text, card_name text,
  set_code text, set_name text, rarity text
) language plpgsql stable security definer set search_path = public, extensions as $$
declare
  me text := public.session_member(p_token);
  after_created_at timestamptz;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  if p_game not in ('yugioh','onepiece') then raise exception 'Gioco non valido'; end if;
  if p_limit not between 1 and 2000 then raise exception 'Limite non valido'; end if;

  if p_after_id is not null then
    select p.created_at into after_created_at
    from public.card_printings p
    where p.id = p_after_id and p.game = p_game;
  end if;

  return query
    select p.id, p.catalog_card_id, p.card_name, p.set_code, p.set_name, p.rarity
    from public.card_printings p
    where p.game = p_game and p.set_code <> ''
      and (
        p_after_id is null
        or after_created_at is null
        or p.created_at > after_created_at
        or (p.created_at = after_created_at and p.id > p_after_id)
      )
    order by p.created_at, p.id
    limit p_limit;
end;
$$;

revoke all on function public.list_catalog_printings_index(text,text,uuid,integer) from public,anon,authenticated;
grant execute on function public.list_catalog_printings_index(text,text,uuid,integer) to anon,authenticated;

notify pgrst, 'reload schema';
