# Audit tecnico camera e continuità delle scansioni — 17 settembre 2026

## Ambito e limiti

Analisi del codice attuale e riproduzioni con mock, senza modifiche al comportamento dell'app. Non è un audit visuale: nessuna sessione autenticata, screenshot, fotocamera fisica o inferenza reale verificata. I difetti sotto sono dimostrati nel codice o in simulazione; non provano quale causa si presenti sul telefono dell'utente. Il documento del 16 settembre descrive anche comportamenti ormai superati: qui si considera l'implementazione corrente.

## Percorso attuale

1. Avvio camera e preparazione OCR paralleli: miglioramento presente, ciclo di vita ancora fragile.
2. Scatto manuale con attesa di un frame fresco: protezione presente per copie consecutive.
3. Primo passaggio rapido con codice valido e confidence >= 88; secondo passaggio per gli altri casi. Letture discordanti/deboli vanno in verifica. La soglia 88 è un punteggio del motore, non una probabilità di correttezza calibrata.
4. Risoluzione locale o verifica persistita in background: buona continuità tecnica, ma invito ad avanzare anche senza identità confermata.
5. Review finale con quantità aggregate: modificabile, ma priva della storia dei singoli scatti.

## Fotocamera: risultati prioritari

### Alta — timeout limitato a getUserMedia

`js/fast-scan-camera.js:12–31`: il timeout termina appena si ottiene lo stream. `video.play()` e `enumerateDevices()` non hanno un limite applicativo. La configurazione focus ha invece già un timeout proprio. Se play resta pendente, start resta sospeso: all'avvio il loop di salute viene programmato solo dopo start, quindi non recupera questa attesa.

Riproduzione: play irrisolto per 40 ms con timeout camera configurato a 10 ms; start resta pendente. Correzione proposta: budget anche per disponibilità del video e inventario dispositivi; inventario opzionale, cleanup dello stream solo se appartenente alla richiesta fallita.

### Alta — cancellazione incompleta dopo acquisizione dello stream

Il controllo generation avviene dopo getUserMedia ma non dopo play/configurazione/enumerazione. Riprodotto: start → play pendente → stop → completamento play; start risolve con successo benché lo stream sia stato fermato.

`js/fast-scan.js:109–114`: recoverCamera non verifica startRequestId o fase dopo await, e imposta esplicitamente phase='scanning'. Un recupero in corso può quindi riattivare lo stato scanner dopo l'apertura della review. Il normale start ha guardie aggiuntive, il recupero no.

Correzione proposta: una generazione per ogni avvio/recupero, invalidata da uscita, review, cambio camera e sospensione; controlli dopo ciascuna attesa. Risultati superati ignorati senza toccare la camera nuova.

### Alta — cleanup incompleto nel recupero fallito

Riprodotto: play rifiuta e FastScanCamera.start lascia la track acquisita viva. Il catch del normale controller.start la ferma; il catch di recoverCamera no. Uno stream può quindi restare occupato mentre l'interfaccia segnala errore.

Correzione proposta: cleanup nello strato camera, condizionato all'identità della richiesta, con stato d'errore coerente nel controller.

### Media — inventario dispositivi trattato come requisito di avvio

Riprodotto: enumerateDevices rifiuta e start fallisce anche se play è riuscito. Il normale controller spegne così uno stream già disponibile. L'elenco serve al cambio camera: un suo errore dovrebbe disabilitare quel controllo, lasciando utilizzabile la preview.

### Media — recupero incompleto da dispositivo non disponibile e video congelato

Start e recovery riutilizzano deviceId con vincolo exact; manca un tentativo con facingMode environment quando quel dispositivo non esiste più. healthIssue verifica track, mute, dimensioni e nero, ma non l'avanzamento effettivo dei frame: lastFrameAt viene aggiornato quando il canvas viene campionato, anche se il video mostra un'immagine ferma. Una preview congelata con dimensioni valide può sfuggire al controllo. Sono rischi da codice, non riproduzioni su hardware.

## OCR e controllo della sessione

### Alta — avanzamento consentito quando resta da decidere

`js/fast-scan.js:325–354, 182–185`: il ramo remoto mostra «avanti, verifico in background»; un esito da verificare invita ancora ad andare avanti. MAX_BACKGROUND_RESOLUTIONS=1 limita il lavoro simultaneo, ma non la lunghezza della coda. Con rete lenta molte carte possono essere fisicamente spostate prima che arrivi l'esito.

Non conviene togliere la cache o rendere obbligatorio il secondo OCR: il problema è il passaggio da lettura a conferma, non solo il tempo d'inferenza.

### Alta — manca una cronologia per scatto

`js/fast-scan-core.js:115–124`: entries è una Map aggregata per printing e snapshot salva entries/review/contatori, non un registro degli scatti. Quando una verifica remota riesce, la riga pending viene rimossa e confluisce nella quantità. Non resta una relazione persistente fra ordine fisico, scatto e carta riconosciuta.

Il live mostra l'ultima aggiunta immediata, che non viene aggiornata dalle aggiunte remote. Il messaggio «Scatto precedente» non identifica un numero di scatto; una sola notifica background può sostituirne un'altra. Non esistono annullamento per singolo scatto o accesso diretto alla relativa correzione.

### Media — Auto-add disattivato non significa conferma obbligatoria

`js/fast-scan.js:484`: EXACT_UNIQUE viene aggiunto comunque; l'opzione autoAdd governa NEAR_UNIQUE. La denominazione nelle impostazioni non rende chiara questa differenza. Una modalità di conferma deve avere una politica esplicita e verificabile.

### Media — scatti senza testo non rimangono nel riepilogo

recordFailure mostra l'errore, ma non crea un elemento persistente. Il contatore scanned rappresenta aggiunte e voci di review, non tutte le pressioni/scatti. Manca quindi anche un segnaposto per la carta che non è stata letta.

## Compromesso consigliato: modalità assistita predefinita

1. Ogni acquisizione ha un ID e un numero progressivo persistenti, prima del riconoscimento. Conservare ordine, ora, codice letto, risultato e stato anche dopo aggregazione. Un tentativo fallito resta identificabile. Le quantità sono derivate da eventi attivi, non corrette rimuovendo l'intera printing.
2. Carta riconosciuta con lettura forte e match autorevole unico: mostrare immagine di catalogo, nome, codice, rarità, numero scatto e «Aggiunta alla sessione». Il pulsante «Prossima carta» conferma visivamente il risultato e scatta la successiva: nessun doppio tap sistematico né attesa artificiale. L'immagine di catalogo non è una foto probatoria della carta fisica.
3. Lettura debole, discordante, ambigua o non trovata: fermarsi sulla carta corrente con «Riprova», «Correggi», «Metti da parte». Quest'ultima azione è esplicita e conserva la voce nella cronologia. Una rarità non determinabile dal solo codice richiede una scelta.
4. Verifica remota pendente: in modalità assistita non suggerire il passaggio alla prossima prima dell'esito. Consentire un rinvio esplicito. Una modalità rapida opzionale può continuare, con coda visibile e limite piccolo da validare (ad esempio 3 pendenti), poi pausa.
5. Durante tutta la sessione: ultime 5 acquisizioni visibili o apribili, cronologia completa, filtro dubbi, «Annulla ultimo scatto» e «Correggi questo scatto». Una risposta remota tardiva non deve ripristinare uno scatto annullato.
6. Feedback distinti per «acquisito», «aggiunto alla sessione», «da verificare». Non chiamare salvata in raccolta una carta ancora nel buffer. Salvataggio finale con riepilogo esplicito delle voci escluse/irrisolte.

Evitare per ora miniature fotografiche persistenti: il progetto attuale libera i pixel dopo l'OCR e i test proteggono questa scelta. Un eventuale ritaglio fotografico locale richiederebbe una decisione separata su memoria, conservazione e cancellazione. Cronologia, immagine catalogo e numero scatto sono implementabili senza cambiare questa politica.

## Ordine di intervento e criteri

1. Correggere ciclo camera: timeout, cancellazione, cleanup, inventario opzionale, fallback device e gestione preview ferma. Test con promesse pendenti, rifiuti e risposte tardive.
2. Introdurre registro per scatto e annullamento coerente con risoluzioni remote, ripresa dopo refresh e quantità duplicate. Preservare la protezione della sincronizzazione parziale.
3. Implementare modalità assistita e messaggi coerenti, mantenendo cache e primo passaggio rapido.
4. Validazione reale su telefono: avvio freddo/caldo, permesso negato e poi concesso, cambio app, blocco schermo, ritorno, cambio camera, uscita durante recupero, rete lenta/offline e almeno 100 carte consecutive incluse copie, foil e codici simili.

Misurare separatamente pressione→identificazione, pressione→possibilità di proseguire, tempo di conferma remota, aggiunte errate e tempo necessario a correggerle. Nessuna promessa di guadagno in millisecondi o accuratezza senza corpus reale.

## Verifiche eseguite

- fast-scan-ocr-pipeline-smoke.mjs: PASS.
- fast-scan-ocr-confusions-smoke.mjs: PASS.
- fast-scan-p0-smoke.mjs: PASS (scenario sintetico 200 scan, 36 printing, 2 chunk).
- fast-scan-milestone-smoke.mjs: PASS.
- fast-scan-camera-audit.mjs: quattro difetti riprodotti. Script diagnostico che verifica la presenza dei difetti attuali, non una suite che certifica la loro correzione; andrà convertito in test di regressione durante il fix.

I test esistenti verdi non coprono tutte le interruzioni asincrone sopra. Nessuna modifica al codice applicativo, deployment o scrittura su servizi esterni eseguita.
