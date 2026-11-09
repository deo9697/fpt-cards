-- One Piece: costo + tipo carta per l'ordinamento del Main nel Deck Builder.
--
-- Richiesta del team 2026-11-09: Main ordinato Character → Event → Stage e,
-- dentro ogni gruppo, dal costo più basso. list_onepiece_card_costs dà solo
-- il costo; questa RPC aggiunge card_type (game_metadata.cardType). Additiva:
-- la vecchia RPC resta (il client la usa come ripiego finché questa non c'è).

create or replace function public.list_onepiece_card_meta(p_token text, p_catalog_card_ids text[])
returns table(catalog_card_id text, cost integer, card_type text)
language plpgsql stable security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token);
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  if p_catalog_card_ids is null or array_length(p_catalog_card_ids, 1) is null then return; end if;
  return query
    select distinct on (p.catalog_card_id) p.catalog_card_id,
      nullif(p.game_metadata->>'cost','')::integer,
      nullif(p.game_metadata->>'cardType','')
    from public.card_printings p
    where p.game = 'onepiece' and p.catalog_card_id = any(p_catalog_card_ids)
    order by p.catalog_card_id, p.id;
end;
$$;

revoke all on function public.list_onepiece_card_meta(text,text[]) from public,anon,authenticated;
grant execute on function public.list_onepiece_card_meta(text,text[]) to anon,authenticated;
