-- Aggiunge al catalogo condiviso due printing che YGOPRODeck non traccia, così
-- Fast Scan non potrà mai crearle da sola:
--  * DUAD-EN082 "Luce the Dusk's Dark" (Duelist's Advance): YGOPRODeck
--    conosce la carta (id 45409943) ma non ha nessuna informazione di
--    stampa. Rarità confermata dall'utente sulla carta fisica: Super Rare.
--  * SDM-I020 "Weather Report" (vecchia edizione italiana di Magic Ruler):
--    YGOPRODeck elenca solo MRL/SRL. Common come ogni altra stampa nota
--    della carta (MRL-020, MRL-E020, SRL-020, SRL-EN020).
--
-- Insert-only e idempotente: not exists invece di on conflict, perché la
-- chiave unica di card_printings include anche variant_id.

insert into public.card_printings (game, catalog_card_id, card_name, set_code, set_name, rarity, image_url)
select v.game, v.catalog_card_id, v.card_name, v.set_code, v.set_name, v.rarity, v.image_url
from (values
  ('yugioh', '45409943', 'Luce the Dusk''s Dark', 'DUAD-EN082', '', 'Super Rare', 'https://images.ygoprodeck.com/images/cards/45409943.jpg'),
  ('yugioh', '72053645', 'Weather Report',        'SDM-I020',   '', 'Common',     'https://images.ygoprodeck.com/images/cards/72053645.jpg')
) as v(game, catalog_card_id, card_name, set_code, set_name, rarity, image_url)
where not exists (
  select 1 from public.card_printings p
  where p.game = v.game and p.catalog_card_id = v.catalog_card_id
    and upper(p.set_code) = upper(v.set_code) and p.rarity = v.rarity
);
