-- F.P.T Cards — One Piece: ordinamento del Main Deck per costo crescente.
-- Migrazione additiva preparata: NON applicata automaticamente al Supabase
-- reale.
--
-- Richiesta utente 2026-09-10: nel Deck Builder One Piece, le carte del
-- Main devono essere mostrate ordinate dal costo più basso al più alto per
-- default (non solo su richiesta come le altre modalità di ordinamento).
--
-- Il costo NON viene persistito su deck_cards (è metadata di catalogo, non
-- un dato di inventario/quantità come le altre colonne di quella tabella):
-- si risolve per catalog_card_id da card_printings.game_metadata, esposto
-- da questa RPC in bulk (stesso ruolo che cardTypesByIds ha per Yu-Gi-Oh,
-- ma la fonte è il nostro catalogo invece di YGOPRODeck).
--
-- distinct on (catalog_card_id): il costo di una carta logica è invariante
-- tra le sue printing (stessa carta, rarità diverse non cambiano il costo),
-- quindi una riga qualunque tra le sue printing basta.
--
-- Carte senza un costo giocabile (es. le Stage, che non ne hanno uno) o non
-- ancora sincronizzate tornano cost null, non 0: 0 è un costo reale (i pochi
-- Leader/Character a costo 0), la differenza conta per l'ordinamento lato
-- client (js/games/onepiece/catalog.js:cardCostsByIds).

create or replace function public.list_onepiece_card_costs(p_token text, p_catalog_card_ids text[])
returns table(catalog_card_id text, cost integer)
language plpgsql stable security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token);
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  if p_catalog_card_ids is null or array_length(p_catalog_card_ids, 1) is null then return; end if;
  return query
    select distinct on (p.catalog_card_id) p.catalog_card_id, nullif(p.game_metadata->>'cost','')::integer
    from public.card_printings p
    where p.game = 'onepiece' and p.catalog_card_id = any(p_catalog_card_ids)
    order by p.catalog_card_id, p.id;
end;
$$;

revoke all on function public.list_onepiece_card_costs(text,text[]) from public,anon,authenticated;
grant execute on function public.list_onepiece_card_costs(text,text[]) to anon,authenticated;

notify pgrst, 'reload schema';
