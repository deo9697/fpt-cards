-- Fast Scan Step B (roadmap performance 2026-09-15) — oggi resolveFast()
-- salta la RPC solo per un codice già risolto in questa sessione
-- (session-cache): qualunque altro set code, anche se il catalogo lo
-- conosce già da tempo, passa comunque da lookup_card_printings_by_set_code
-- alla prima volta che viene scansionato nella sessione. Questo aggiunge un
-- round-trip di rete nel loop della fotocamera per praticamente ogni carta.
--
-- Questa RPC permette invece di scaricare in pagine un indice locale
-- compatto (nessuna immagine, solo identità) di TUTTE le printing di un
-- gioco, cacheable in IndexedDB lato client: card_printings è catalogo
-- condiviso (stesso principio già usato da lookup_card_printings_by_catalog_id
-- e list_ygo_printings_for_backfill), quindi nessun filtro ownership.
create or replace function public.list_catalog_printings_index(
  p_token text, p_game text, p_after_id uuid default null, p_limit integer default 1000
) returns table(
  printing_id uuid, catalog_card_id text, card_name text,
  set_code text, set_name text, rarity text
) language plpgsql stable security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token);
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  if p_game not in ('yugioh','onepiece') then raise exception 'Gioco non valido'; end if;
  if p_limit not between 1 and 2000 then raise exception 'Limite non valido'; end if;
  return query
    select p.id, p.catalog_card_id, p.card_name, p.set_code, p.set_name, p.rarity
    from public.card_printings p
    where p.game = p_game and p.set_code <> ''
      and (p_after_id is null or p.id > p_after_id)
    order by p.id
    limit p_limit;
end;
$$;

revoke all on function public.list_catalog_printings_index(text,text,uuid,integer) from public,anon,authenticated;
grant execute on function public.list_catalog_printings_index(text,text,uuid,integer) to anon,authenticated;

notify pgrst, 'reload schema';
