# Yu-Gi-Oh! — combattimento guidato

Il tavolo FPT applica il combattimento standard sul servizio autorevole, mantenendo manuali gli effetti delle carte. Arena, partecipazione privata del team e mazzi salvati rimangono quelli di FPT.

## Flusso su telefono

Nella propria Battle Phase, dopo il primo turno, un Mostro scoperto in Attacco propone Attacca nel menu rapido. Si sceglie un Mostro avversario tramite la casella illuminata, comprese le Zone Mostri Extra; se non ci sono Mostri avversari è disponibile Attacco diretto. Prima della dichiarazione è possibile annullare la scelta senza consumare l’attacco.

La richiesta indica soltanto il proprio attaccante e la zona/casella pubblica del bersaglio. Non invia l’identità privata di un difensore coperto. L’attaccante consuma il proprio attacco al momento della dichiarazione. I controlli di risposta occupano il pannello delle fasi, lasciando liberi campo e mano; i pulsanti del combattimento hanno altezza minima di 44 px.

Entrambi possono dichiarare effetti con Activate. Una catena aperta deve essere completata prima di proseguire. Due passaggi nella risposta aprono il Damage Step e scoprono l’eventuale difensore coperto; altri due applicano il combattimento standard. Il servizio rilegge ATK/DEF e modificatori correnti, aggiorna i LP e sposta le carte distrutte atomicamente. A zero LP per il danno da combattimento viene registrato il risultato.

Durante il combattimento non si cambia fase o turno. Prima del Damage Step, un cambiamento dei Mostri avversari richiede una nuova scelta del bersaglio o la rinuncia. Rinunciare dopo la dichiarazione conserva il consumo dell’attacco. Dopo l’inizio del Damage Step non si può ritirare liberamente l’attacco. Un attaccante rimosso, coperto o passato in Difesa interrompe il combattimento; la scomparsa del difensore nel Damage Step non apre un replay.

## Regole applicate

- Attacco contro Attacco: confronto dei valori, differenza ai LP e distruzione secondo l’esito; a parità positiva entrambi sono distrutti, mentre 0 contro 0 non distrugge nessuno.
- Attacco contro Difesa: nessun danno perforante implicito. ATK maggiore distrugge il difensore, ATK minore infligge la differenza all’attaccante senza distruggerlo, parità senza danni o distruzione.
- Attacco diretto: il campo avversario deve essere vuoto al momento della scelta. Un nuovo Mostro prima del Damage Step richiede un replay; durante il Damage Step non si ripete la scelta.
- Sono inclusi i Mostri nelle Zone Mostri Extra, i Segna-Mostro, il rilascio dei materiali Xyz e la destinazione Extra scoperta dei Pendulum distrutti sul campo.
- Un Mostro che ha dichiarato un attacco non può cambiare posizione manualmente nello stesso turno. Uscire dalla Zona Mostri azzera la cronologia dell’istanza per un successivo ingresso.

ATK/DEF nulli o negativi, come i valori variabili non ancora determinati, non vengono assunti pari a zero. Nei comandi avanzati della carta, Valore attuale permette di dichiarare un valore numerico; Variazione continua ad aggiungere o sottrarre un modificatore. Il valore assoluto azzera il modificatore precedente e quelli successivi si sommano normalmente. I valori sono applicati dal servizio e usati anche nella visualizzazione.

## Effetti particolari

Protezioni dalla distruzione, danni modificati o sostituiti, attacchi aggiuntivi o in Difesa, danno perforante, restrizioni di bersaglio e timing specifici non sono interpretati dal testo della carta. Non sono un motore automatico completo degli effetti.

Nel Damage Step, il giocatore con priorità può proporre Esito manuale. L’altro giocatore deve accettare: il combattimento termina senza applicare danni o distruzione standard, mantenendo l’attacco consumato. I giocatori applicano poi il risultato dell’effetto con i comandi manuali. Rifiutando si torna al Damage Step con i passaggi azzerati. Durante l’attesa di accordo non si prosegue, non si annulla liberamente e non si avvia una nuova catena.

Le due finestre di passaggio sono controlli guidati del tavolo manuale; non implementano tutte le sottofasi del Damage Step né le regole complete di Spell Speed, trigger e sostituzione.

## Compatibilità e verifiche

Il combattimento guidato richiede i controlli del turno delle nuove partite. Per iniziare una prova con cronologia degli attacchi completa è consigliato un nuovo duello. Non ci sono modifiche SQL o alle autorizzazioni. Il campo passivo di Testa mazzo passa automaticamente le risposte e conferma le richieste manuali; il risultato locale offre Ricomincia test e Scegli un altro mazzo.

La rotazione in verticale annulla coerentemente selezioni, posizionamenti e dialoghi dipendenti, evitando di lasciare aperta una scelta senza la sua carta selezionata. Gli aggiornamenti remoti invalidano le scelte non ancora inviate; le azioni del servizio conservano controllo di partecipazione, versione e idempotenza.

Verifiche aggiunte:

- `yugioh-battle-smoke.mjs`: quindici gruppi sul motore, inclusi confronti, privacy, catene, replay, annullamenti, destinazioni, valori correnti, vittoria e accordo manuale.
- `yugioh-battle-client-smoke.mjs`: selezione differita, coordinate pubbliche, versione, statistiche assolute, esito e regressione della rotazione con dialoghi aperti.
- `yugioh-duel-server-smoke.mjs`: autorità del servizio, attori avversari, valori di danno inventati ignorati, richieste tardive/ripetute e risultato condiviso.
- Prove browser con due client sintetici e tocchi nativi; casi dedicati e prova locale con campo passivo. Le fixture non creano inviti, partite o notifiche reali.

Artifact locali: `battle-target-phone.png`, `battle-response-phone.png`, `battle-damage-phone.png`, `battle-manual-phone.png`, `practice-battle-phone.png`. Gli artifact non sono inclusi nel codice pubblicato.

Riferimento delle regole standard: [regolamento ufficiale Konami](https://img.yugioh-card.com/en/downloads/rulebook/SD_RuleBook_EN_10.pdf), sezioni Battle Step, Replay, Damage Step e Monster Battle Rules.

Esito finale: tutti i 21 script della suite verificati. Prove browser dedicate del combattimento e dell’accordo manuale, prova locale e regressione completa superate su 844×390, 932×430 e 740×360. Zero eccezioni JavaScript, errori console, risorse mancanti o richieste esterne inattese. Controlli del combattimento di almeno 44 px e bersagli coperti privati fino al Damage Step.
