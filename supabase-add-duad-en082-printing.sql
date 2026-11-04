-- Aggiunge al catalogo condiviso la printing DUAD-EN082 "Luce the Dusk's
-- Dark", un'altra carta del set "Duelist's Advance" (DUAD) che YGOPRODeck
-- conosce come carta (id 45409943) ma per cui non ha nessuna informazione
-- di stampa/rarità, in nessuna lingua: non c'è quindi nessuna fonte esterna
-- da cui Fast Scan possa risolverla automaticamente, esattamente come già
-- successo per le 4 printing R.B. (supabase-add-duad-rb-printings.sql).
-- Rarità confermata dall'utente guardando la carta fisica: Super Rare.
--
-- Dopo questa migration, sia Fast Scan che l'inserimento manuale
-- troveranno questa printing esattamente come già succede per le altre
-- printing DUAD già presenti.

insert into public.card_printings (game, catalog_card_id, card_name, set_code, set_name, rarity, image_url) values
  ('yugioh', '45409943', 'Luce the Dusk''s Dark', 'DUAD-EN082', '', 'Super Rare', 'https://images.ygoprodeck.com/images/cards/45409943.jpg')
on conflict (game, catalog_card_id, set_code, rarity) do nothing;
