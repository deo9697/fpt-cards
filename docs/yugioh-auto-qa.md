# Duelli TCG automatici

Nuovi inviti dall’Arena: scegli Automatico · Regole TCG oppure Manuale guidato. I tavoli esistenti e il campo locale Testa mazzo mantengono i propri comandi. L’automatico usa l’arena mobile FPT e una vera esecuzione del motore; il client presenta soltanto scelte autorizzate, senza inviare spostamenti o risultati inventati.

## Riproducibilità e limiti

- Motore fissato `ocgcore-wasm@0.1.6`, regole MR5 moderne con ordinamento simultaneo TCG. Banlist TCG e disponibilità canonica controllate dal server.
- Risorse locali con revisioni e checksum in `api/yugioh-auto-data/manifest.json`. Nessun download di script o codice dell’utente durante il gioco.
- Seed privato, mazzi iniziali e input validati persistiti nello stato JSON del duello. Ogni scelta ricostruisce il duello: i riavvii delle funzioni non perdono la partita. I sondaggi leggono le viste persistite senza ricalcolare il motore.
- Worker separato, timeout effettivo di 20 secondi; limite cooperativo 15 secondi/100.000 iterazioni e 4.096 input. Errori o timeout non salvano una mossa parziale. Una versione differente del motore/risorse rifiuta i vecchi replay invece di alterarne l’esito.
- Proiezioni positive per partecipante: nessun seed, transcript, messaggio nativo o lista del mazzo al browser. Prima dell’invito il mazzo auto viene validato dai dati canonici, senza usare vecchi flag di banlist o tipi salvati nella collezione. I risultati, la resa, CAS, idempotenza e appartenenza corrente al team sono controllati dal servizio.
- Il protocollo copre tutte le richieste decisionali del core, comprese selezioni iterative/materiali, ordine, tributi, segnalini, zone, posizioni, dichiarazioni con ricerca filtrata e catene. Le compatibilità necessarie del wrapper 0.1.6 (query TLV e risposta SORT_CARD) sono isolate nel confine del core.
- La modalità automatica usa gli script inclusi. Non garantisce la parità certificata con ogni interazione di Master Duel o un arbitro ufficiale; la UI, il catalogo e la banlist sono quelli indicati da FPT. Errori Lua espliciti non ricadono nel manuale.

## Verifiche

`npm run test:yugioh-auto`: protocollo, mazzi TCG, inizializzazione dell’intero catalogo TCG, scenari reali di meccaniche/eventi/decisioni, effetti/catene e replay, servizio privato con CAS, UI e due browser mobile con servizio e worker reali. `npm run test:yugioh-simulator`: regressioni dei tavoli manuali, orientamento, touch, Testa mazzo, combattimento e percorso One Piece. La [matrice di verifica](yugioh-auto-mechanics-matrix.md) distingue casi reali, prove sintetiche e limiti della copertura.

`npm run build:yugioh-auto-resources` richiede Node con `node:sqlite` e accesso ai repository pubblici fissati. Produce gli stessi archivi e checksum; non è necessario durante l’avvio del duello o il deploy. Le risorse del motore restano lato server e non entrano nel precache della PWA.

La funzione Vercel include esplicitamente il worker, i moduli del motore, i dati compressi e il pacchetto WASM. L’arena collega gli avvisi e i sorgenti attraverso `assets/licenses/yugioh-auto.html`.

Il profilo risorse `-tcg-r2` include la revisione corretta di Red-Eyes Darkness Metal Dragon, che lo snapshot upstream conserva nella cartella `pre-errata`. Viene inclusa soltanto quella sorgente esatta, conforme al testo TCG corrente, senza importare in blocco script storici. Gli archivi di base e il profilo precedente rimangono immutati: i replay delle partite aperte prima del rilascio mantengono versione e identificativi delle richieste.
