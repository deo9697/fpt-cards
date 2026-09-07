-- Aggiunge al catalogo condiviso 4 printing dell'archetipo "R.B." che non
-- esistono in nessuna lingua sul database esterno (ygoprodeck) — set
-- "DUAD", un prodotto/box europeo distinto da "Doom of Dimensions" (DOOD),
-- che ygoprodeck non traccia affatto. La carta sottostante (nome, id
-- catalogo, immagine) è confermata su ygoprodeck; il codice set/rarità è
-- quello riportato dall'utente guardando le carte fisiche. rarity lasciata
-- vuota (non specificata) — modificabile in app se serve.
--
-- Dopo questa migration, sia Fast Scan che l'inserimento manuale
-- troveranno queste 4 printing esattamente come già succede per
-- DOOD-IT096 "R.B. Next Phase" (già presente).

insert into public.card_printings (game, catalog_card_id, card_name, set_code, set_name, rarity, image_url) values
  ('yugioh', '44573911', 'R.B. Ga10 Pile Bunker', 'DUAD-IT090', '', '', 'https://images.ygoprodeck.com/images/cards/44573911.jpg'),
  ('yugioh', '33438265', 'R.B. Ga10 Cutter',      'DUAD-IT091', '', '', 'https://images.ygoprodeck.com/images/cards/33438265.jpg'),
  ('yugioh', '79436874', 'R.B. VALCan Rocket',    'DUAD-IT092', '', '', 'https://images.ygoprodeck.com/images/cards/79436874.jpg'),
  ('yugioh', '78710386', 'R.B. Funk Dock',        'DUAD-IT095', '', '', 'https://images.ygoprodeck.com/images/cards/78710386.jpg')
on conflict (game, catalog_card_id, set_code, rarity) do nothing;
