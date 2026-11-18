# Duelli TCG automatici

Nuovi inviti dall’Arena: scegli Automatico · Regole TCG oppure Manuale guidato. Testa mazzo propone lo stesso motore automatico per i propri mazzi salvati; resta disponibile anche la prova manuale locale. I tavoli esistenti mantengono i propri comandi. L’automatico usa l’arena mobile FPT e una vera esecuzione del motore; il client presenta soltanto scelte autorizzate, senza inviare spostamenti o risultati inventati.

## Testa mazzo automatico

La prova personale usa costi, timing, catene, materiali, effetti da mano/Cimitero/bandite e condizioni di vittoria dello stesso duello TCG. Il campo avversario usa una copia del proprio mazzo e risponde con una politica passiva deterministica: passa le risposte facoltative e conclude il turno, ma esegue le scelte obbligatorie del motore. Non è un avversario strategico. Pescate, limite della mano ed eventuali effetti obbligatori restano regolati dal core.

Una sessione corrente per membro/team è conservata per 24 ore nella tabella privata `yugioh_practice_sessions`, senza inviti, push, righe PvP o statistiche condivise. Il browser controlla soltanto il giocatore 0; anche le risposte passive entrano nel transcript server e sono riproducibili. Riprendi recupera il campo, Ricomincia test crea una nuova prova, Cambia mazzo torna alla selezione. La variante manuale continua in memoria come prima. La migrazione revoca ai ruoli client l’accesso alla tabella e impone appartenenza attiva e versioni consecutive.

Su telefono il launcher Azioni si trova nella colonna delle fasi, così Cimitero, Bandite, Deck e caselle restano toccabili. Le pile con scelte legali sono evidenziate, le opzioni indicano la zona d’origine e ogni materiale Xyz mantiene il proprio indice. I controlli di una richiesta precedente vengono ignorati anche quando il core riutilizza lo stesso identificativo di opzione.

Gli effetti fuori dal terreno hanno scenari reali dedicati: Mezuki con bersaglio rimosso da D.D. Crow, Plaguespreader, Wulf/Felis, Breakthrough Skill, Lost Wind, Necro Gardna, Necrovalley/Macro Cosmos, Giant Rex, Thunder Dragondark, Veiler, Zephyros, Grapha, Sangan e Trick Clown usati come materiali. Sono prove di queste interazioni precise, non una certificazione di tutte le combinazioni del catalogo.

## Riproducibilità e limiti

- Motore fissato `ocgcore-wasm@0.1.6`, regole MR5 moderne con ordinamento simultaneo TCG. Banlist TCG e disponibilità canonica controllate dal server.
- Risorse locali con revisioni e checksum in `api/yugioh-auto-data/manifest.json`. Nessun download di script o codice dell’utente durante il gioco.
- Seed privato, mazzi iniziali e input validati persistiti nello stato JSON del duello. Ogni scelta ricostruisce il duello: i riavvii delle funzioni non perdono la partita. I sondaggi leggono le viste persistite senza ricalcolare il motore.
- Worker separato, timeout effettivo di 20 secondi; limite cooperativo 15 secondi/100.000 iterazioni e 4.096 input. Errori o timeout non salvano una mossa parziale. Una versione differente del motore/risorse rifiuta i vecchi replay invece di alterarne l’esito.
- Proiezioni positive per partecipante: nessun seed, transcript, messaggio nativo o lista del mazzo al browser. Prima dell’invito il mazzo auto viene validato dai dati canonici, senza usare vecchi flag di banlist o tipi salvati nella collezione. I risultati, la resa, CAS, idempotenza e appartenenza corrente al team sono controllati dal servizio.
- Il protocollo copre tutte le richieste decisionali del core, comprese selezioni iterative/materiali, ordine, tributi, segnalini, zone, posizioni, dichiarazioni con ricerca filtrata e catene. Le compatibilità necessarie del wrapper 0.1.6 (query TLV e risposta SORT_CARD) sono isolate nel confine del core.
- La modalità automatica usa gli script inclusi. Non garantisce la parità certificata con ogni interazione di Master Duel o un arbitro ufficiale; la UI, il catalogo e la banlist sono quelli indicati da FPT. Errori Lua espliciti non ricadono nel manuale.

## Verifiche

L'ottimizzazione del worker, dei round trip e del render mobile è documentata in [yugioh-performance-qa.md](yugioh-performance-qa.md), con misure prima/dopo e limiti della prova.

`npm run test:yugioh-auto`: protocollo, mazzi TCG, inizializzazione dell’intero catalogo TCG, scenari reali di meccaniche/eventi/decisioni, effetti/catene e replay, servizio privato con CAS, UI e due browser mobile con servizio e worker reali. `npm run test:yugioh-simulator`: regressioni dei tavoli manuali, orientamento, touch, Testa mazzo, combattimento e percorso One Piece. La [matrice di verifica](yugioh-auto-mechanics-matrix.md) distingue casi reali, prove sintetiche e limiti della copertura.

`npm run build:yugioh-auto-resources` richiede Node con `node:sqlite` e accesso ai repository pubblici fissati. Produce gli stessi archivi e checksum; non è necessario durante l’avvio del duello o il deploy. Le risorse del motore restano lato server e non entrano nel precache della PWA.

La funzione Vercel include esplicitamente il worker, i moduli del motore, i dati compressi e il pacchetto WASM. L’arena collega gli avvisi e i sorgenti attraverso `assets/licenses/yugioh-auto.html`.

Il test personale esegue tocchi nativi a 844×390 e 740×360, più il gate a 390×844: quattro scansioni di 28 obiettivi (20 caselle e 8 pile) verificano con `elementFromPoint` che il launcher compatto non li copra. Il percorso reale Foolish → Zephyros dal Cimitero → ritorno del mostro in mano → evocazione e 400 danni attraversa handler, servizio e worker. Ripresa dopo reload, nuovo ID al riavvio, turno passivo e rilascio fullscreen sono verificati; non compaiono errori console/rete o scritture PvP. Le immagini mancanti dalla cache locale del test sono sostituite da un placeholder offline: queste prove non attestano la disponibilità del fornitore esterno di artwork.

Il profilo risorse `-tcg-r2` include la revisione corretta di Red-Eyes Darkness Metal Dragon, che lo snapshot upstream conserva nella cartella `pre-errata`. Viene inclusa soltanto quella sorgente esatta, conforme al testo TCG corrente, senza importare in blocco script storici. Gli archivi di base e il profilo precedente rimangono immutati: i replay delle partite aperte prima del rilascio mantengono versione e identificativi delle richieste.
