-- F.P.T Cards — Backfill printing "Legendary Collection" (LC01) per i tre Dei
-- Egizi. Migration additiva, non applicata automaticamente.
--
-- Causa verificata (non ipotizzata): ygoprodeck non ha ALCUNA associazione
-- set/carta per Obelisk/Slifer/Ra in "Legendary Collection" (in nessuna
-- lingua), quindi né la lookup diretta né il fallback IT->EN già presente
-- in js/cards.js (catalogSetCodeCandidates) possono funzionare: il dato
-- manca proprio a monte, non è un problema di OCR o di normalizzazione.
-- Le altre tre carte del box (Blue-Eyes/Dark Magician/Red-Eyes, IT004-006)
-- SONO già su ygoprodeck come LC01-EN004/005/006: se continuano a fallire
-- la scansione è un problema diverso, da verificare a parte.
--
-- Ambiguità nota: ygoprodeck espone due edizioni sotto lo stesso set_code
-- (Legendary Collection 2010 "Ultra Rare" e la ristampa "25th Anniversary
-- Edition" 2023 "Quarter Century Secret Rare" — verificato su Blue-Eyes
-- LC01-EN004, che le ha entrambe). Inserisco entrambe le rarità per ogni
-- Dio: se la carta scansionata è ambigua tra le due, Fast Scan la mette
-- semplicemente in "Da verificare" con entrambe le scelte a schermo
-- (comportamento già esistente, corretto in questa stessa sessione).

insert into public.card_printings(game, catalog_card_id, card_name, set_code, set_name, rarity, image_url)
values
  ('yugioh', '10000000', 'Obelisk the Tormentor',   'LC01-IT001', 'Legendary Collection', 'Ultra Rare',                 'https://images.ygoprodeck.com/images/cards/10000000.jpg'),
  ('yugioh', '10000000', 'Obelisk the Tormentor',   'LC01-IT001', 'Legendary Collection', 'Quarter Century Secret Rare','https://images.ygoprodeck.com/images/cards/10000000.jpg'),
  ('yugioh', '10000010', 'The Winged Dragon of Ra', 'LC01-IT002', 'Legendary Collection', 'Ultra Rare',                 'https://images.ygoprodeck.com/images/cards/10000010.jpg'),
  ('yugioh', '10000010', 'The Winged Dragon of Ra', 'LC01-IT002', 'Legendary Collection', 'Quarter Century Secret Rare','https://images.ygoprodeck.com/images/cards/10000010.jpg'),
  ('yugioh', '10000020', 'Slifer the Sky Dragon',   'LC01-IT003', 'Legendary Collection', 'Ultra Rare',                 'https://images.ygoprodeck.com/images/cards/10000020.jpg'),
  ('yugioh', '10000020', 'Slifer the Sky Dragon',   'LC01-IT003', 'Legendary Collection', 'Quarter Century Secret Rare','https://images.ygoprodeck.com/images/cards/10000020.jpg')
on conflict (game, catalog_card_id, set_code, rarity) do nothing;
