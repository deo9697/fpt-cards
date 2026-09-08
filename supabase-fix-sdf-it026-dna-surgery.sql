-- F.P.T Cards — aggiunge la printing mancante DNA Surgery (SDF-IT026):
-- Fast Scan/OCR non la trova perché ygoprodeck non ha questo set-code
-- esclusivo Italia (Servitore del Faraone, 2002) nel suo catalogo — stesso
-- schema di supabase-fix-old-starter-deck-printings.sql e
-- supabase-fix-sgx4-enc14-fossil-dig.sql: buco della fonte dati esterna,
-- non un bug nostro.
--
-- Nota codice: l'utente l'aveva letto come "SDF-1026" — il codice ufficiale
-- è in realtà "SDF-IT026" ("IT" prima del numero, facile da confondere con
-- "1" leggendo la carta fisica, stessa identica confusione già trovata su
-- MIK-I029/MIY-I030 in supabase-fix-old-starter-deck-printings.sql).
-- Confermato su listing di vendita italiano (andycards.it, espansione SDF,
-- pagina card): "SDF IT026 — Intervento Sul Dna — Comune".
--
-- catalog_card_id (passcode) e image_url confermati dalla vera API
-- YGOPRODeck (cardinfo.php?name=DNA Surgery), stesso identificatore usato
-- per ogni altra printing di questa carta nel catalogo.

insert into public.card_printings (game, catalog_card_id, card_name, set_code, set_name, rarity, image_url)
values
  ('yugioh', '74701381', 'DNA Surgery', 'SDF-IT026', 'Servitore del Faraone', 'Common',
    'https://images.ygoprodeck.com/images/cards/74701381.jpg')
on conflict (game, catalog_card_id, set_code, rarity) do nothing;
