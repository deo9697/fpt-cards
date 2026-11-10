# Arena Yu-Gi-Oh! — verifica funzionale e visiva

Data: 10 novembre 2026.

## Perimetro

Simulatore manuale multiplayer privato del team, integrato in FPT nella pagina Altro del gioco Yu-Gi-Oh!. Le sessioni, il motore e la tabella sono separati da One Piece. Effetti, costi, requisiti di evocazione, battaglie e timing restano decisioni dei giocatori; la catena registra attivazioni e risoluzioni manuali.

## Collaudo

Due contesti Chrome indipendenti eseguono il controller e il servizio HTTP reali con membri, mazzi e store sintetici. Il test SQL usa Postgres PGlite. Nessun invito o notifica reale è stato inviato e nessuna partita di produzione è stata creata.

| Verifica | Esito |
| --- | --- |
| Invito, scelta del proprio Main/Extra/Side, pronto di entrambi | PASS |
| Mostri: evocazione in Attacco/Difesa, set, scoperta, cambio posizione, slot stabili | PASS |
| Magia coperta, attivazione, catena manuale, risoluzione e Cimitero | PASS |
| Modificatori ATK, segnalini, LP, materiali Xyz e distacco | PASS |
| Segna-Mostro, rimozione, Extra Monster Zone condivise e collisioni | PASS |
| Conservazione carte, materiali annidati, Pendulum, limiti delle zone, Link senza Difesa | PASS |
| Mano, Extra/Side e carte settate private; registro senza identità segrete | PASS |
| Controlli avversari bloccati, accesso di terzi negato, conflitti senza mosse duplicate | PASS |
| Risposte tardive, cambio profilo/tavolo, chiusura dell'ispezione privata | PASS |
| Ricerca nel mazzo quando l'ispezione aggiorna una versione precedente del tavolo | PASS |
| Fasi, turno, ripresa dopo ricaricamento e risultato condiviso | PASS |
| Tocchi effettivi su smartphone: selezione, evocazione nello slot e invio al Cimitero | PASS |
| Entrambi i giochi: Altro, caricamento su richiesta, notifiche/link e inviti prima del login | PASS |
| Regressione accesso, Raccolta, Mazzi e flussi principali FPT | PASS |

L'ultimo collaudo browser termina con eccezioni JavaScript, errori console, risorse mancanti e richieste esterne tutti assenti. La prima prova della navigazione aveva un timeout CDP; il controllo successivo ha individuato un'attesa di test troppo generica che accettava il pannello di caricamento come invito pronto. Ora aspetta il comando dell'invito effettivamente caricato e il flusso completo passa.

## Base dati

Applicata la migrazione `20261110172720_yugioh_private_multiplayer.sql`, con versione locale allineata al registro del progetto. Verificato sul database: RLS attiva, nessun accesso SELECT anon/authenticated, nessuna policy browser, nessuna pubblicazione Realtime; accesso del servizio presente. Le due funzioni nuove sono SECURITY INVOKER, con search_path fissato e senza EXECUTE per anon/authenticated. L'advisor segnala soltanto l'INFO atteso per la tabella con RLS senza policy browser. L'identità riusa il resolver del team già presente.

## Confronto visivo

Riferimento: [schermata ufficiale Master Duel](https://www.yugioh-card.com/en/wp-content/uploads/2022/01/screenshot1.png), copia locale `artifacts/yugioh-duel/reference/master-duel-official-board.png` (767×431). Il riferimento include un effetto di danno e una carta selezionata; la nostra cattura mostra un tavolo manuale in attesa di selezione. Non si tratta dello stesso stato di partita e non viene dichiarata una replica pixel per pixel o 3D.

Implementazione: `artifacts/yugioh-duel/desktop-reference.png`, viewport 1440×810, deviceScaleFactor 1. Confronto combinato normalizzato a 768×432 per ciascuna immagine: `artifacts/yugioh-duel/comparison-after.png`. Ulteriori catture: `desktop.png` (1440×1000), `mobile.png` (390×844), `landscape.png` (844×390), `card.png` per il pannello touch.

- Tipografia: gerarchia chiara, LP numerici leggibili, comandi e testo carta separati; font già disponibili in FPT.
- Spaziatura: due campi, cinque zone Mostri e cinque Magie/Trappole per lato, due zone Extra condivise, pile laterali e mano inferiore. Nessun overflow orizzontale nei tre viewport verificati.
- Colori: superficie in pietra con interfaccia blu/oro e indicatore della fase attiva.
- Immagini: texture e retro originali raster ottimizzati (circa 424 KB insieme); carte di prova con immagini locali reali. Immagini del campo tutte caricate.
- Contenuto: comandi italiani e indicazioni esplicite sulla risoluzione manuale; nessun controllo core puramente decorativo.

### Iterazioni

1. P2: badge dei segnalini troppo largo sulle carte piccole in verticale. Corretto con dimensionamento al contenuto e rimozione dell'ancoraggio destro; confermato nella cattura mobile finale.
2. P2: entrambi gli HUD LP erano in alto, con mano desktop troppo piccola rispetto al riferimento. HUD proprio spostato nell'angolo inferiore sinistro su desktop/orizzontale, avversario in alto a destra e mano desktop ingrandita. In verticale restano due HUD superiori per leggibilità. Evidenza precedente: `desktop-before-polish.png`; successiva: `desktop-reference.png` e `landscape.png`.

Il pannello carta mobile finale consente di leggere l'immagine, vedere ATK/DEF e usare i comandi senza coperture indesiderate. Restano come possibili evoluzioni scenari e personaggi 3D, animazioni cinematiche, suoni ed effetti automatici: non fanno parte di questa arena manuale.

final result: passed
