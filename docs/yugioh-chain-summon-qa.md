# Yu-Gi-Oh! — catene e materiali di evocazione

## Comportamento

- In mano, anche i Mostri hanno Activate accanto a Normal Summon, Special Summon e Set. L'attivazione dichiara l'effetto e rende pubblico il relativo anello; la carta rimane in mano, mentre scarti, tributi e altri costi restano manuali. Le altre carte della mano avversaria rimangono private.
- Ogni anello mostra un cerchio con il simbolo della catena e il numero su entrambi i client. La risposta spetta prima all'altro giocatore; una nuova attivazione incrementa il numero e azzera i passaggi. Due Non rispondo consecutivi chiudono la costruzione della catena.
- Risolvi #N rimuove un anello alla volta, dal maggiore al minore. Gli effetti vengono applicati manualmente; durante la risoluzione non si aggiungono anelli. Il cambio fase/turno attende che la catena sia completata. In Testa mazzo il campo passivo passa automaticamente la risposta.
- Magie/Trappole attivate scegliendo una casella vengono giocate e aggiunte alla catena in un'unica operazione: una priorità errata, una casella occupata o un altro errore non lasciano la carta già scoperta sul campo.
- Dall'Extra Deck, Special Summon di un Synchro o Xyz apre la scelta dei propri materiali scoperti. Dopo la conferma si sceglie la casella, anche una di quelle liberate dai materiali. Il trascinamento su una casella permette lo stesso flusso.
- La procedura standard Synchro verifica i Tuner/non-Tuner richiesti e la somma dei Livelli. I materiali ordinari vanno al Cimitero; i Pendulum seguono la destinazione Extra scoperta e i Segna-Mostro vengono rimossi.
- La procedura standard Xyz verifica materiali dello stesso Livello compatibili con il Rango stampato e il numero richiesto dalla ricetta. Il Rango dello Xyz rimane un dato della carta. I materiali non vanno al Cimitero: vengono conservati sotto lo Xyz. Segna-Mostro, Xyz e Link non sono materiali validi per questa procedura standard.
- Attivando un Xyz sul terreno si sceglie se l'effetto richiede distacco e quali materiali usare. Il costo scelto viene pagato insieme all'attivazione, prima della creazione dell'anello. Materiali insufficienti, duplicati o non attaccati a quel mostro vengono respinti senza modifiche. La scelta senza distacco serve agli effetti che non lo richiedono; il simulatore non attribuisce un costo universale a tutti gli effetti Xyz.

## Limiti dei controlli

Sono controlli delle procedure standard, non un motore completo degli effetti. Spell Speed, timing, bersagli, cambi di Livello/Tuner e procedure alternative dipendono dal testo e dalle decisioni dei giocatori. Le ricette generiche EN/IT vengono riconosciute; requisiti particolari richiedono anche la conferma sul testo, mantenendo i controlli di base sui materiali. Le procedure alternative, come Rank-Up o evocazioni per effetto con materiali diversi da quelli standard, non sono automatizzate da questa selezione.

Le nuove partite caricano Livello, Rango e Tuner da metadati del catalogo del servizio. I dati mancanti della stampa salvata vengono integrati tramite il catalogo pubblico; campi nulli non sovrascrivono i valori disponibili. Le vecchie partite senza Livelli richiedono un nuovo tavolo per queste evocazioni guidate. Le catene delle vecchie partite rimangono compatibili.

Nessuna modifica SQL: lo stato JSON continua a essere scritto soltanto dal servizio, con controlli di partecipazione e versione. Le richieste del browser indicano azioni e identificativi, senza caricare lo stato completo o metadati arbitrari dei materiali.

## Verifiche

La suite `npm run test:yugioh-simulator` include test puri delle catene e delle ricette, integrazione del motore, servizio, metadati, Postgres e browser mobile con due giocatori sintetici. I nuovi test coprono annullamenti atomici, priorità, materiali avversari/coperte/duplicati, livelli mancanti, Tuner, somma, Rango, materiali sovrapposti e costi di distacco. Nessun tavolo o invito di produzione viene creato dai test.

Esito finale: tutti i 17 script della suite superati. Il browser completo verifica due client e tre viewport (844×390, 932×430, 740×360), cerchi 1/2 condivisi e risoluzione 2→1, Synchro 3+5 con controllo Tuner, Xyz con due Livello 4, distacco prima dell'anello e caselle liberate dai materiali. I pulsanti di conferma e costo sono raggiunti tramite scorrimento e tocchi nativi. Un ulteriore controllo locale verifica i riepiloghi Rango 4 e somma Livelli 8. Zero eccezioni JavaScript, errori console, risorse mancanti o richieste esterne inattese.

Catture in `artifacts/yugioh-duel/`: `chain-two-host.png`, `chain-two-guest.png`, `xyz-materials.png`, `xyz-effect-cost.png`, `synchro-materials.png`, `xyz-confirm-native.png`, `xyz-cost-confirm-native.png`. Gli artifact non sono inclusi nel codice pubblicato.

Riferimenti ufficiali: [Synchro e Xyz — Konami](https://eu-support.konami.com/hc/en-gb/articles/9698595851415-Yu-Gi-Oh-TCG-Xyz-Monsters-Synchro-Monsters-Ritual-Monsters-and-Fusion-Monsters), [Fast Effect Timing](https://www.yugioh-card.com/en/play/fast-effect-timing/), [regolamento](https://www.yugioh-card.com/en/rulebook/).
