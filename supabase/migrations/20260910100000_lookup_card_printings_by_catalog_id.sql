-- F.P.T Cards — l'editor Raccolta usa YGOPRODeck come unica fonte per
-- elencare set/rarità di una carta, quindi mostra un sottoinsieme incompleto
-- quando YGOPRODeck non ha (ancora, o mai) tutte le rarità reali di una
-- stampa che il nostro card_printings ha già verificato altrove (Fast Scan,
-- Market Watch, ecc.). Caso reale: CH01-EN019 — The Fallen & The Virtuous,
-- che deve mostrare Ultra Rare, Secret Rare e Starlight Rare.
--
-- Stesso pattern (token + game + solo lettura, nessun filtro ownership dato
-- che card_printings è catalogo condiviso) di lookup_card_printings_by_set_code
-- in supabase-milestone-3-fast-scan.sql — qui cerchiamo per catalog_card_id
-- invece che per set_code, per popolare l'editor con TUTTE le stampe note
-- per la carta selezionata, non solo quelle del set digitato.

create or replace function public.lookup_card_printings_by_catalog_id(
  p_token text, p_game text, p_catalog_card_id text
) returns table(
  printing_id uuid, game text, catalog_card_id text, card_name text,
  set_code text, set_name text, rarity text, image_url text
) language plpgsql stable security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token); normalized text := trim(coalesce(p_catalog_card_id,''));
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  if p_game not in ('yugioh','onepiece') or char_length(normalized) not between 1 and 100 then
    raise exception 'Identificativo catalogo non valido'; end if;
  return query select p.id,p.game,p.catalog_card_id,p.card_name,p.set_code,p.set_name,p.rarity,p.image_url
    from public.card_printings p where p.game=p_game and p.catalog_card_id=normalized
    order by p.set_code,p.rarity;
end;
$$;

revoke all on function public.lookup_card_printings_by_catalog_id(text,text,text) from public,anon,authenticated;
grant execute on function public.lookup_card_printings_by_catalog_id(text,text,text) to anon,authenticated;

notify pgrst, 'reload schema';
