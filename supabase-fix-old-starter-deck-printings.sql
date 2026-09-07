-- F.P.T Cards — aggiunge 3 printing mancanti da ygoprodeck: vecchi Mazzi
-- Introduttivi italiani (2002-2004), Fast Scan/OCR non le trova perché
-- ygoprodeck non ha questi set-code esclusivi Italia nel suo catalogo
-- (verificato in sessione, 2026-09-07 — stesso schema di
-- supabase-fix-sgx4-enc14-fossil-dig.sql: buco della fonte dati esterna,
-- non un bug nostro. Dati confermati sul database ufficiale Konami,
-- db.yugioh-card.com, non da ygoprodeck).
--
-- Nota codici: l'utente li aveva scritti come "MIK-1029"/"MIY-1030" — sul
-- database ufficiale sono in realtà "MIK-I029"/"MIY-I030" (una "I" prima
-- del numero, facile da confondere con "1" leggendo la carta fisica).
--
-- image_url riusa l'artwork reale della carta da ygoprodeck (stesso artwork
-- in ogni printing/rarità).

insert into public.card_printings (game, catalog_card_id, card_name, set_code, set_name, rarity, image_url)
values
  ('yugioh', '66788016', 'Fissure', 'MIK-I029', 'Mazzo Introduttivo Kaiba', 'Common',
    'https://images.ygoprodeck.com/images/cards/66788016.jpg'),
  ('yugioh', '4031928', 'Change of Heart', 'MIY-I030', 'Mazzo Introduttivo Yugi', 'Common',
    'https://images.ygoprodeck.com/images/cards/4031928.jpg'),
  ('yugioh', '99597615', 'Malevolent Nuzzler', 'SYE-IT036', 'Mazzo Introduttivo Yugi Evoluzione', 'Common',
    'https://images.ygoprodeck.com/images/cards/99597615.jpg')
on conflict (game, catalog_card_id, set_code, rarity) do nothing;
