-- Correzione: DUAD-IT090 era stata collegata a "R.B. Ga10 Pile Bunker" per
-- errore mio (traduzione semantica sbagliata di "Perforante/Perforatore").
-- La carta corretta, confermata dall'utente sulla carta fisica, è
-- "R.B. Ga10 Driller" ("perforatore" è la traduzione letteralmente corretta
-- di "driller", non di "pile bunker").
--
-- UPDATE in-place (non delete+insert): se la carta era già stata
-- aggiunta alla raccolta di qualcuno con il collegamento sbagliato,
-- questa correzione la sistema automaticamente senza dover toccare
-- collection_items — la riga card_printings resta la stessa, cambia solo
-- a quale carta del catalogo punta.

update public.card_printings
set catalog_card_id = '6043161',
    card_name = 'R.B. Ga10 Driller',
    image_url = 'https://images.ygoprodeck.com/images/cards/6043161.jpg',
    updated_at = now()
where game = 'yugioh' and set_code = 'DUAD-IT090' and catalog_card_id = '44573911';
