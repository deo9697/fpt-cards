-- F.P.T Cards — aggiunge la printing mancante DNA Surgery (SDF-I026):
-- Fast Scan/OCR non la trova perché ygoprodeck non ha questo set-code
-- esclusivo Italia (Servitore del Faraone, 2002) nel suo catalogo — stesso
-- schema di supabase-fix-old-starter-deck-printings.sql e
-- supabase-fix-sgx4-enc14-fossil-dig.sql: buco della fonte dati esterna,
-- non un bug nostro.
--
-- Nota codice, corretta due volte: prima letto come "SDF-1026", poi come
-- "SDF-IT026" (un rivenditore online usava quel formato per questa
-- espansione) — l'utente ha poi controllato la carta fisica di persona:
-- il codice reale è "SDF-I026", una sola lettera, come MIK-I029/MIY-I030
-- in supabase-fix-old-starter-deck-printings.sql. La carta fisica prevale
-- su qualunque fonte secondaria in caso di conflitto.
--
-- L'UPDATE prima dell'INSERT sistema in place l'eventuale riga già inserita
-- con il set_code sbagliato "SDF-IT026" (se questa migration era già stata
-- eseguita prima della correzione) senza creare un doppione — preserva id/
-- created_at e qualunque collection_items che la referenzi già.
--
-- catalog_card_id (passcode) e image_url confermati dalla vera API
-- YGOPRODeck (cardinfo.php?name=DNA Surgery), stesso identificatore usato
-- per ogni altra printing di questa carta nel catalogo.

update public.card_printings
set set_code = 'SDF-I026'
where game = 'yugioh' and catalog_card_id = '74701381' and set_code = 'SDF-IT026' and rarity = 'Common';

insert into public.card_printings (game, catalog_card_id, card_name, set_code, set_name, rarity, image_url)
values
  ('yugioh', '74701381', 'DNA Surgery', 'SDF-I026', 'Servitore del Faraone', 'Common',
    'https://images.ygoprodeck.com/images/cards/74701381.jpg')
on conflict (game, catalog_card_id, set_code, rarity) do nothing;
