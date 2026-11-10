# One Piece — verifica dei comandi del tavolo

Data: 10 novembre 2026.

Esito: **PASS**. Nessuna eccezione JavaScript, errore console, risorsa mancante o richiesta esterna durante la partita sintetica.

## Ambiente e perimetro

`node scripts/onepiece-duel-browser-smoke.mjs --screenshots` esegue il componente e il servizio duelli reali, con due contesti Chrome indipendenti. I giocatori, i mazzi, lo store e la consegna delle notifiche sono fixture locali: nessun account, invito, dato, database o abbonamento push di produzione è stato usato. Il test verifica anche le risposte HTTP del servizio locale e la proiezione privata dello stato.

I due mazzi contengono un Leader e 50 carte Main. Per il tavolo di esempio sono usate illustrazioni del catalogo, disponibili localmente in `artifacts/onepiece-duel/cards/`. Valori ed effetti delle fixture sono di prova; non rappresentano una verifica del ruling di ogni singola carta.

## Comandi verificati

| Flusso | Risultato |
| --- | --- |
| Invito, accettazione con il proprio mazzo, Life iniziali, scelta del primo giocatore | PASS |
| Mulligan singolo e avvio dopo il pronto di entrambi | PASS |
| Pesca e gioco Personaggio dal modulo e scegliendo una posizione libera | PASS |
| Cinque posizioni per lato, piazzamento nello slot 5, KO senza compattare le altre posizioni | PASS |
| Riposa carta e Attiva carta | PASS |
| DON!! dal mazzo, attivazione e riposo, assegnazione, rimozione e DON!!− assegnato/rested/attivo | PASS |
| Modificatori +1000/−1000 e potere visualizzato comprensivo del DON!! nel proprio turno | PASS |
| Stage nella zona Stage, riposo e riattivazione con Refresh | PASS |
| Evento con risoluzione manuale verso Trash; nessun suggerimento per giocarlo come Personaggio/Stage | PASS |
| Refresh, mescola mazzo/Life, ricerca privata, Life → mano e lettura del Trash | PASS |
| Life scoperta e ricoperta, pubblicazione e oscuramento su entrambi i dispositivi | PASS |
| Ispezione delle proprie Life seguita dall'apertura delle Life avversarie senza riutilizzare le carte private | PASS |
| Copri/Mostra mano, apertura e chiusura della scheda carta, strumenti, regole e statistiche | PASS |
| Ritorno nella lobby, rientro e ripresa dopo ricaricamento della pagina | PASS |
| Avanzamento di ogni fase, passaggio turno e blocco dei controlli turno dell'avversario | PASS |
| Conflitto di versione visibile, nessuna pesca duplicata, recupero e riprova | PASS |
| Conclusione con risultato condiviso, rifiuto e annullamento degli inviti successivi | PASS |
| Mano/mazzo/Life nascosti, impossibilità di ispezionare il mazzo avversario e di leggere il duello come terzo membro | PASS |

## Smartphone e immagini

Verificati desktop 1440×1000 e 1440×876, smartphone 390×844 e 844×390. Entrambi i lati restano visibili, senza overflow orizzontale della pagina. I controlli abilitati e visibili ricevono il puntamento sul proprio contenuto, senza elementi che li coprano. Il pannello della carta su smartphone è fisso e si chiude correttamente.

La prova su smartphone include eventi touch CDP effettivi: tocco su carta in mano, apertura delle azioni, scelta dello slot, piazzamento e successivo spostamento nel Trash. Entrambe le modifiche sono state ricevute dal secondo giocatore.

Screenshot della partita raggiunta attraverso i normali comandi, con due Personaggi per lato, Stage, Trash, una carta Rest e DON!! assegnato:

- [Desktop](../artifacts/onepiece-duel/commands-desktop-reference.png)
- [Smartphone verticale](../artifacts/onepiece-duel/commands-mobile-viewport.png)
- [Smartphone orizzontale](../artifacts/onepiece-duel/commands-landscape.png)
- [Scheda carta su smartphone](../artifacts/onepiece-duel/commands-mobile-card.png)

## Limite del simulatore manuale

Giocare o riposare una carta e modificare i DON!! funziona. Il pagamento dei costi, gli effetti delle carte, attacchi, Blocker, Counter e Trigger richiedono la risoluzione dei giocatori. Il comando dell'Evento lo porta nel Trash dopo la risoluzione manuale; non esegue automaticamente il suo testo. Il collaudo locale non attesta la consegna di una notifica push reale né la disponibilità del database di produzione.
