-- F.P.T Cards — aggiunge una printing mancante da ygoprodeck: "Fossil Dig"
-- (Normal Spell, catalog_card_id 47325505) in Speed Duel GX: Midterm
-- Destruction, set code SGX4-ENC14, rarità Common.
--
-- ygoprodeck non ha ANCORA indicizzato l'intero set SGX4 (uscito 2024-03-29):
-- sia /cardinfo.php?name=Fossil%20Dig sia /cardsetsinfo.php?setcode=SGX4-ENC14
-- non lo restituiscono (verificato in sessione, 2026-09-07) — non è un bug
-- di Fast Scan/OCR, è un vero buco nella fonte dati esterna, stesso schema
-- già visto per altri set vecchi/regionali: si risolve inserendo la printing
-- a mano, non aggiungendo un'altra fonte dati (vedi nota progetto "Fast Scan:
-- speed over coverage").
--
-- image_url riusa l'artwork reale della carta (ID catalogo 47325505, la
-- stessa in ogni printing/rarità di Fossil Dig), già su ygoprodeck.
--
-- Idempotente: on conflict sull'unique (game, catalog_card_id, set_code,
-- rarity) già presente sulla tabella non fa nulla se rieseguito.

insert into public.card_printings (game, catalog_card_id, card_name, set_code, set_name, rarity, image_url)
values (
  'yugioh', '47325505', 'Fossil Dig', 'SGX4-ENC14', 'Speed Duel GX: Midterm Destruction', 'Common',
  'https://images.ygoprodeck.com/images/cards/47325505.jpg'
)
on conflict (game, catalog_card_id, set_code, rarity) do nothing;
