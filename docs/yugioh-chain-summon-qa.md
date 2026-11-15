# Yu-Gi-Oh! — catene e materiali di evocazione

## Comportamento

- In mano, anche i Mostri hanno Activate accanto a Normal Summon, Special Summon e Set. L'attivazione dichiara l'effetto e rende pubblico il relativo anello; la carta rimane in mano, mentre scarti, tributi e altri costi restano manuali. Le altre carte della mano avversaria rimangono private.
- Ogni nuova attivazione mostra la carta al centro per circa due secondi, con il cerchio e il numero sovrapposti all’immagine su entrambi i client. Dopo la rivelazione resta una miniatura della carta con il proprio numero fino alla risoluzione. La risposta spetta prima all'altro giocatore; una nuova attivazione incrementa il numero e azzera i passaggi. Due Non rispondo consecutivi chiudono la costruzione della catena.
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

Esito finale: tutti i 21 script della suite superati. Il browser completo verifica due client e tre viewport (844×390, 932×430, 740×360), cerchi 1/2 condivisi e risoluzione 2→1, Synchro 3+5 con controllo Tuner, Xyz con due Livello 4, distacco prima dell'anello e caselle liberate dai materiali. I pulsanti di conferma e costo sono raggiunti tramite scorrimento e tocchi nativi. Un ulteriore controllo locale verifica i riepiloghi Rango 4 e somma Livelli 8. Zero eccezioni JavaScript, errori console, risorse mancanti o richieste esterne inattese.

Catture in `artifacts/yugioh-duel/`: `chain-two-host.png`, `chain-two-guest.png`, `xyz-materials.png`, `xyz-effect-cost.png`, `synchro-materials.png`, `xyz-confirm-native.png`, `xyz-cost-confirm-native.png`. Gli artifact non sono inclusi nel codice pubblicato.

Riferimenti ufficiali: [Synchro e Xyz — Konami](https://eu-support.konami.com/hc/en-gb/articles/9698595851415-Yu-Gi-Oh-TCG-Xyz-Monsters-Synchro-Monsters-Ritual-Monsters-and-Fusion-Monsters), [Fast Effect Timing](https://www.yugioh-card.com/en/play/fast-effect-timing/), [regolamento](https://www.yugioh-card.com/en/rulebook/).

## Rivelazione della carta attivata

L’immagine della rivelazione proviene dall’anello pubblico di attivazione. Per gli anelli precedenti senza immagine, si cerca solo la stessa carta già visibile; una carta privata dell’avversario non viene letta per ricostruire l’immagine. Se l’artwork manca, vengono mostrati nome e segnaposto.

Ogni nuova attivazione ha un identificativo pubblico distinto: la stessa carta può attivarsi di nuovo in una nuova catena senza perdere la rivelazione. Polling invariato, Non rispondo, risoluzione e riapertura di una catena esistente non riavviano l’effetto. Un nuovo anello sostituisce l’anteprima precedente e il suo timer; uscita, cambio tavolo e reset li eliminano.

Il contenitore, l’immagine e il badge non intercettano tocchi. Alla scadenza viene rimossa solo l’anteprima, senza ricreare il campo: pressione lunga, trascinamento e scorrimento della mano possono continuare. La preferenza di sistema per ridurre le animazioni è rispettata.

Il test `yugioh-reveal-smoke.mjs` copre durata, passaggi/polling, risposte ravvicinate, risoluzione inversa, stati tardivi, ripetizione della stessa carta, navigazione e privacy. Le prove browser confrontano due artwork diversi sui due client e verificano anche che il campo mantenga lo stesso elemento DOM quando scade la rivelazione. Su telefoni 844×390 e 740×360 controllano proporzioni, ingresso completamente visibile, badge sulla carta e pulsante di risposta raggiungibile sotto l’overlay. Catture dedicate: `activation-one-host.png`, `activation-one-guest.png`, `activation-two-host.png`, `activation-two-guest.png`.

## Posizione di Evocazione Speciale

Sp. Summon apre un piccolo selettore con la carta verticale per Attacco e orizzontale per Difesa, entrambe scoperte. Il tocco sceglie prima la posizione e poi una casella evidenziata; trascinando la carta su una casella, il selettore conserva quella destinazione. Per i Link è disponibile solo Attacco, come previsto dal [regolamento ufficiale Konami](https://img.yugioh-card.com/en/downloads/rulebook/SD_RuleBook_EN_10.pdf).

La selezione non invia richieste né modifica il campo prima della conferma della giocata. Indietro torna alle azioni della carta; chiudere annulla l’evocazione. Un aggiornamento remoto invalida anche il selettore di posizione. Synchro e Xyz mantengono la posizione scelta nel passaggio successivo dei materiali; Fusion e Link conservano la scelta delle zone consentite. Il flusso si applica anche a Testa mazzo e alle evocazioni manuali da altre pile.

È un’interazione guidata per il simulatore manuale. Le limitazioni e le eccezioni previste da singoli effetti continuano a essere applicate dai giocatori; questa modifica non introduce un motore automatico degli effetti.

I test di azioni, menu e controller coprono Attacco/Difesa da tocco e trascinamento, nessun invio prematuro, destinazione conservata, Link, materiali Synchro/Xyz, ritorno, annullamento e versioni remote. Le prove browser usano tocchi nativi e due client per controllare il risultato condiviso, la rotazione della carta, la leggibilità e la raggiungibilità dei pulsanti sul telefono. Catture: `special-position-choice.png`, `special-defense-phone.png`.

## Regole base del turno e tributi

Le nuove partite includono `turnState`, scritto dal motore e conservato nello stato JSON del servizio. I tavoli precedenti senza questo campo mantengono i comandi manuali: non viene ricostruita una quota già consumata a metà turno. Nessuna modifica SQL o alle autorizzazioni di partecipazione.

- Draw normale: una carta nella propria Draw Phase, una sola volta; il primo turno salta la pescata. Per proseguire bisogna effettuare la pescata dovuta. Pesca per effetto è un comando manuale distinto e non consuma la pescata normale.
- Le fasi avanzano da Draw a Standby e Main 1. Da Main 1 si può entrare in Battle oppure passare a End; Main 2 segue Battle. Nel primo turno Battle e Main 2 non sono disponibili. Cambi fase e turno attendono che la catena sia vuota.
- Normal Summon e Normal Set condividono una quota di una giocata, solo nella propria Main Phase. La quota si azzera al nuovo turno. Un comando esplicito negli strumenti dichiara un effetto che concede una Normale aggiuntiva.
- La procedura standard richiede zero tributi fino al Livello 4, uno ai Livelli 5–6 e due dal Livello 7. La scelta include i propri Mostri scoperti, coperti e Segna-Mostro. Conferma, consumo dei tributi e giocata sono atomici; la destinazione può essere una casella liberata. Pendulum, Token e materiali Xyz seguono le rispettive destinazioni. Un errore non consuma né carte né quota; il Set mantiene privata l’identità del nuovo Mostro.
- Il cambio posizione normale è consentito nella propria Main Phase, una volta per turno e non nel turno di ingresso del Mostro. Flip Summon scopre in Attacco. Coprire o scoprire in Difesa è dichiarato come effetto. Gli effetti di posizione restano comandi distinti e non aggirano i vincoli strutturali dei Link o dei Token.
- Fine turno con più di sei carte apre la selezione degli scarti. La conferma scarta esattamente l’eccedenza e passa il turno in un’unica operazione; annullamento e aggiornamenti remoti non effettuano scarti. Su telefono l’elenco scorre all’interno, con riepilogo e conferma visibili.

Le eccezioni scritte sulle singole carte, i tributi alternativi, la modifica del limite di mano, gli effetti di Standby/End e le finestre di risposta restano manuali. Il vincolo di cambio posizione dopo un attacco è controllato per gli attacchi del combattimento guidato. Gli spostamenti avanzati rimangono disponibili per applicare gli effetti dichiarati; non sono conteggiati come Evocazioni Normali.

`yugioh-turn-rules-smoke.mjs` verifica controlli standard, annullamenti atomici, privacy, versione e flusso controller. Il servizio verifica anche gli stessi limiti senza fidarsi del browser. La prova locale comprende 38 round, fino al turno 77, e continua quando il mazzo del campo passivo è esaurito. Le prove browser dedicate coprono due client e tocchi nativi; catture: `tribute-phone.png`, `normal-limit-phone.png`, `end-turn-discard-phone.png`.

Riferimento: [regolamento ufficiale Konami, evocazioni e struttura del turno](https://img.yugioh-card.com/en/downloads/rulebook/SD_RuleBook_EN_10.pdf).

Verifica finale del blocco turni: 18 script non browser superati, prova browser dedicata dei turni superata, prova locale superata e regressione completa multiplayer superata su 844×390, 932×430 e 740×360. Zero eccezioni JavaScript, errori console, risorse mancanti o richieste esterne inattese. Header, riepilogo e conferma dei dialoghi tributi/scarti sono raggiungibili insieme; gli elenchi scorrono al loro interno. Cattura aggiuntiva: `tribute-two-phone.png`.

Il combattimento standard è descritto in [yugioh-battle-qa.md](yugioh-battle-qa.md), con limiti degli effetti manuali, nuove verifiche e compatibilità.
