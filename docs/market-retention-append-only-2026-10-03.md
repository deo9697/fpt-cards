# FPT Cards — ripristino append-only e retention conservativa

**Esito locale: test rigorosi verdi. SAFE TO APPLY CLEANUP = NO sul live non verificato.**

Questo report sostituisce la strategia rolling del report `market-retention-egress-2026-10-03.md`. Nessun commit, push, deploy, accesso al DB live, modifica di secret, DELETE live o VACUUM. Le sole cancellazioni di righe eseguite sono test su dati sintetici in PostgreSQL/WASM in memoria, eliminato alla chiusura del processo.

## 1. Causa del fallimento rolling

Il modello esistente usa osservazioni immutabili: BEFORE INSERT calcola le anomalie, AFTER INSERT genera gli eventi e promuove il current. L'upsert su una chiave stabile `:current` cambiava il significato dello snapshot:

- Il flag calcolato dal BEFORE INSERT non veniva copiato sull'UPDATE perché `is_anomalous` non era tra le colonne inviate dal writer.
- Il trigger eventi AFTER INSERT non veniva eseguito sull'UPDATE. Inoltre i riferimenti degli eventi esistenti potevano puntare a prezzi successivamente modificati.
- La funzione current confronta timestamp e ID; stesso ID e timestamp non promuovono una correzione del valore.

Non sono stati aggiunti trigger UPDATE per adattare anomalie o eventi al rolling. È stato ripristinato il contratto INSERT originale.

## 2. File cambiati

| File | Risultato |
| --- | --- |
| `supabase/functions/market-sync/index.ts` | Ripristinati `pendingSnapshots`, chiave giornaliera e ignore-duplicates. Conservate le modifiche precedenti al filtro della priority queue e `rpcPages`. Il diff rispetto a HEAD contiene ora solo queste modifiche egress precedenti. |
| `supabase/migrations/20261003203253_market_snapshot_storage_hardening.sql` | Rimosso dalla catena locale attiva; nessun altro file migration modificato. |
| `docs/archive/20261003203253_market_snapshot_storage_hardening.sql` | Conservata la ricostruzione precedente come archivio della versione riportata live, non come migration da applicare. Non è un dump live certificato. |
| `supabase/manual/market-append-only-restore.sql` | Preparata rimozione del solo trigger value-update e relativa funzione; nessuna modifica dati o ai trigger INSERT/anomaly lifecycle. Non eseguito live. |
| `scripts/market-snapshot-retention-policy.sql` | Unica sorgente della classificazione conservativa. |
| `scripts/build-market-retention-sql.mjs` | Genera gli artefatti SQL locali; `--check` impedisce divergenze tra policy, dry run e funzione cleanup. Nessuna connessione DB. |
| `scripts/market-snapshot-retention-dry-run.sql` | Report SELECT-only autonomo: quattro bucket, conteggi, stime byte, provider/type/date, FK e reader/view installati. |
| `supabase/manual/market-snapshot-retention-design.sql` | Installazione proposta di funzioni private classify/cleanup, senza invocazione, scheduler o esposizione frontend. |
| `scripts/market-snapshot-retention-smoke.mjs` | Sostituiti i test di caratterizzazione dei bug con assert rigorosi sul comportamento append-only e cleanup locale. Nessuna tolleranza di blocker noti. |
| `scripts/market-watch-core-smoke.mjs` | Ripristinate le aspettative originali; nessun diff semantico finale rispetto a HEAD. |
| `scripts/market-watch-loading-smoke.mjs` | Corretto il test obsoleto: verifica refresh del contenuto DOPO la risposta e nessuna ricostruzione della toolbar. Frontend invariato. |
| `scripts/market-watch-browser-smoke.mjs` | Harness isolato senza bootstrap/config dell'app reale; richieste Supabase bloccate nel browser. Assert funzionali preservati. |
| `package.json` | `test:market-retention` rigoroso; `test:market-retention-sql-sync` per artefatti generati. Modifiche preesistenti conservate. |
| Report corrente e precedente | Documentazione attuale e marcatura esplicita del report rolling come superato. |

Non esistono writer applicativi legittimi di UPDATE dei valori prezzo dopo il ripristino. Rimane la conferma manuale `is_anomalous=false` con il suo trigger dedicato. Il value-update trigger non serve al modello ripristinato.

**Migration history:** il live risulta avere già registrato `20261003203253`; spostare il file locale non annulla quel record. Non usare un generico migration push/reset o marcare falsamente la versione come mai applicata. Il rollout sotto usa lo script manuale di rimozione e conserva il record storico; prima di riutilizzare un flusso automatico di migration va riconciliata esplicitamente la catena con quel record e un eventuale successivo intervento compensativo.

## 3. Comportamento append-only ripristinato

- Ogni **nuova osservazione giornaliera accettata** crea un nuovo ID. Chiave `<mapping_id>:YYYY-MM-DD`, conflitto `(provider,observation_key,price_type)`, `resolution=ignore-duplicates,return=minimal`.
- Un secondo sync nello stesso giorno è ignorato, anche se cambia il prezzo o coincide il timestamp: non corregge né sovrascrive l'osservazione accettata. Questo è il contratto originale richiesto, non un modello con ogni chiamata intraday archiviata.
- Tutte le metriche, incluse foil, tornano allo stesso percorso INSERT. Batch di 250 e gestione errori/log/queue invariati.
- Gli eventi continuano a riferire snapshot distinti e immutabili. La generazione eventi anche per un INSERT anomalo è il comportamento SQL preesistente, conservato.
- CardTrader non viene riattivato: la compatibilità generica del writer e lo storico `reference` sono testati con provider fixture.
- Il numero di nuovi INSERT giornalieri torna al livello precedente. La riduzione dello storage deriva dalla retention futura, non da un artificiale conteggio di righe create inferiore.

## 4. Reader verificati e regole di retention

| Reader reale | Consumo verificato | Conseguenza |
| --- | --- | --- |
| `list_market_price_history`, SQL operativo milestone 5.1 | Solo Cardmarket/trend e CardTrader/reference, daily distinct UTC, massimo 365 giorni. | Conservare tutte le osservazioni primarie negli ultimi 365 giorni. |
| `list_market_watch_owned_page`, `list_market_watch_extra`, migration current cutover | Current layer per prezzi presenti; snapshot per delta 24h, 7d, 30d. La scelta fallback ammette anche metriche secondarie. | Le metriche secondarie NON sono solo current; minimo intervallo effettivo 30 giorni. |
| `list_market_watch`, migration snapshot reuse | Legacy ancora presente: snapshot per prezzo presente e delta; stessi cutoff senza limite inferiore di età. | Conservare ultimi valori e osservazioni di riferimento precedenti ai cutoff anche per serie sparse. |
| `list_market_dashboard_movers`, migration dashboard cutover | Current layer, trend/avg1/avg7/avg30, freschezza 48h e LIMIT 3. | AVG30 è il valore della metrica corrente del provider, non una media che la RPC ricalcola da 30 snapshot. |
| Summary, single-printing price | Current layer. | Protezione assoluta dei puntatori current. |
| `market_latest_prices`, richieste collection share, Variant exact-price shadow | Snapshot latest tramite view attive. | Preservare gli ultimi candidati per mapping/tipo/valuta anche per mapping oggi inattivi. |
| Anomaly detection, anomaly list, confirm/rebuild | Precedenti e righe anomale; current può tornare al precedente valido. | Conservare anomalie irrisolte e due timestamp recenti, inclusi due validi, per serie. |
| `market_price_events`, alert scan | Riferimenti previous/current; FK CASCADE verso gli snapshot. | Non rimuovere alcun ID referenziato. |

Policy fissa, non accorciabile dai parametri della funzione:

1. **Primary:** almeno 365 giorni per `cardmarket/trend` e `cardtrader/reference`. Non viene selezionata una singola riga per giorno cancellando le altre: eventuali varianti/duplicati storici sono conservati nel periodo.
2. **Safety window:** tutte le metriche per 35 giorni, ossia 30 giorni richiesti dai delta più 5 di margine operativo. Non è una nuova richiesta prodotto, è una scelta conservativa documentata.
3. **Riferimenti:** tutti gli ID current, previous-event e current-event sono intoccabili, senza scadenza. FK ulteriori/non riconosciute bloccano conservativamente l'intero cleanup finché non vengono auditate, anche se il relativo conteggio di righe è zero.
4. **Ultimi valori e fallback:** due timestamp più recenti, più due non anomali, per printing/mapping/provider/type/currency; tutte le righe in pareggio. Conserva dati utili anche se il layer current è incompleto o il mapping cambia stato.
5. **Storico sparso:** ultimo snapshot non anomalo con prezzo normalizzato non nullo a o prima dei cutoff 24h/7d/30d, per la stessa serie. Nessuna soglia massima di età per questi riferimenti: una carta senza dati recenti può avere il fallback di 80 giorni fa.
6. **Quarantena:** tutte le righe anomale e tutte le vecchie chiavi `:current` vengono conservate. Il rollback del codice non ripara retroattivamente valori, flag o riferimenti già modificati live.
7. Solo ciò che resta fuori da queste protezioni è `cleanup_candidate`, incluse eventuali righe primarie oltre 365 giorni prive di dipendenze.

I bucket sono esclusivi, con precedenza `history_series` (primarie entro 365d), `referenced`, `retention_keep`, `cleanup_candidate`. Il conteggio FK separato include anche sovrapposizioni con `history_series`.

**Limite di crescita:** se ogni cambiamento genera eventi conservati per sempre, molte righe vecchie resteranno referenziate per sempre. Questa policy elimina ridondanze non referenziate, ma non promette una dimensione DB costante né il recupero di 304.887 righe. Un'eventuale retention degli eventi richiederebbe un task e requisiti separati.

**Pareggi legacy:** le selezioni storiche ordinano per priorità metrica e timestamp senza un tie-breaker completo. Durante i test, due metriche foil con valori diversi ma stessa priorità/timestamp hanno prodotto vincitori diversi pur essendo entrambe conservate. È un'ambiguità preesistente del reader: la policy preserva tutte le alternative e non inventa una precedenza nuova. La prova di parità esatta usa fixture senza pareggi di prezzo ambigui; prima del live occorre censire quelli reali. Nessuna modifica silenziosa delle RPC per far passare il test.

## 5. Cleanup a batch preparato

`supabase/manual/market-snapshot-retention-design.sql` definisce:

- `fpt_retention.classify_market_snapshots()` con la medesima policy del dry run.
- `fpt_retention.cleanup_market_snapshots(dry_run boolean default true, max_rows integer default 100)`, risultato tabellare `(snapshot_id, action)`; `would_delete` nel dry run, `deleted` dopo una cancellazione autorizzata.

Nessuna chiamata di cleanup è inclusa nell'artefatto. Nessun cron, VACUUM o frontend. Schema privato, EXECUTE e USAGE revocati a PUBLIC/anon/authenticated; servizio autorizzato esplicitamente. SECURITY INVOKER, search_path fisso e oggetti qualificati; controllo runtime del ruolo SQL `postgres`, `service_role` o superuser, anche nell'ipotesi di un grant accidentale al frontend. Non è un controllo del claim JWT admin.

Il chiamante non può passare ID arbitrari o cutoff. `max_rows` deve essere 1–1000; NULL, zero, negativi, oltre 1000 e dry_run NULL vengono rifiutati. Ogni chiamata ricalcola i candidati; ripetere su dataset già trattato restituisce zero righe.

Per il percorso distruttivo, il livello deve essere READ COMMITTED. Prima della classificazione prende lock `SHARE ROW EXCLUSIVE NOWAIT` su snapshot/current/events: fallisce se un writer sta operando, anziché attendere. Le verifiche FK sono ripetute nella DELETE; FK sconosciute, trigger DELETE o regole non auditate bloccano l'operazione. La modalità è deliberatamente conservativa: i writer restano bloccati durante il breve batch, le letture normali possono continuare. Il chiamante deve impostare un `statement_timeout` prima della chiamata e terminare la transazione subito dopo ogni batch; non racchiudere molti batch in una transazione lunga.

Il batch limita le righe cancellate, **non il lavoro del classificatore**, che scansiona lo storico. Tempi/lock su ~400k righe devono essere misurati su clone prima di autorizzare produzione. I test PGlite non simulano writer PostgreSQL concorrenti distinti.

La scelta lock + READ COMMITTED segue la documentazione PostgreSQL su [LOCK](https://www.postgresql.org/docs/current/sql-lock.html) e [isolamento delle transazioni](https://www.postgresql.org/docs/current/transaction-iso.html).

## 6. Test rigorosi e regressioni

**25 suite eseguite, 25 passate**, includendo la nuova suite rigorosa. Comandi entry point: `npm run test:market-retention` e `npm run test:market-retention-sql-sync`; esecuzione locale effettuata con Node 22.13.0 e dipendenze già presenti.

- `market-watch`: core, mw1, loading, owned-page-query, summary-perf, current-price-layer, current-price-cutover, bulk-confirm-aggregate, browser.
- `market-variant`: resolver, canary-poller, admin-panel, exact-price-shadow, exact-price-shadow-panel, candidate-metadata, set-template, mapping-source-check, backfill, backfill-panel.
- `market-sync-egress`, `market-dashboard-movers-cutover`, `dashboard-movers`, `dashboard-trends-browser`, `catalog-market-names`.
- Nuova `market-snapshot-retention`.

La nuova suite esegue **SQL reali del repository** su schema fixture minimo, non una riscrittura JavaScript dei trigger. Prova: ripristino idempotente del trigger live archiviato; INSERT anomalo per metrica non primaria; eventi con ID differenti; current promotion/confirm/rebuild; immutabilità dopo retry/correzione nello stesso giorno; tutte le metriche, incluse foil e compatibilità reference; grafici 7/30/90/365 giorni; batch da 250 e contratto errori.

Per retention: dry run senza mutazioni; rifiuto parametri/isolation errati; protezione riferimenti già esistenti e aggiunti **tra dry run e cleanup**; protezione quarantena; 13 righe sintetiche ridondanti eliminate in batch da massimo 3; seconda esecuzione senza candidati; current ed eventi invariati; confronto prima/dopo di `list_market_watch`, extra, summary, dashboard movers, owned page per name/price/value/change e grafici primari. FK aggiuntiva CASCADE e trigger DELETE sconosciuti bloccano il cleanup. Provati revoche frontend, guard runtime anche con grant accidentale e percorso service-role.

Gli smoke Chrome hanno verificato Market Watch mobile, paginazione 60/130, sort, dettaglio, conferma lazy e dashboard a 360/390/768/1440 px. Nessuna invocazione di RPC reali. Server preview terminato al termine.

Il precedente errore loading era un test non aggiornato al refresh che preserva la barra di ricerca: ora verifica che il refresh avvenga dopo la risposta e non ricrei la toolbar. Non è stato cambiato il codice prodotto per adattarlo al test.

Verificati anche sintassi Node dei file test/generatore modificati, coerenza degli SQL generati e `git diff --check`. Lint e typecheck non sono configurati nel package; nessun nuovo toolchain introdotto. PostgreSQL live/PostgREST e concorrenza multi-sessione non sono stati testati.

## 7. Stima cleanup e gate

Il dry run produce conteggi totali/per bucket/per provider/per price_type, min/max captured_at, byte logici stimati e allocazione proporzionale dello spazio relazione. La stima fisica include pro quota indici/TOAST/spazio libero: **non è spazio garantito recuperabile** e non implica riduzione immediata del file su disco.

I valori precedenti forniti — ~68.214 history, ~36.596 referenced, ~304.887 candidate — appartengono alla classificazione precedente. Non sono hardcoded né verificati nuovamente. La nuova finestra 35d, le osservazioni di riferimento dei delta, i fallback e la quarantena possono ridurre fortemente i candidati, fino a zero se lo storico è abbastanza recente. Non è possibile ricavare una nuova stima live affidabile dal solo totale di righe/MB.

**SAFE TO APPLY CLEANUP = NO.** I test locali sono verdi, ma restano necessari: verifica schema/dipendenze reali, audit degli effetti del rolling già attivo, censimento dei pareggi legacy, dry run autorizzato con visibilità completa e prova clone/concorrenza/prestazioni. Un esito locale verde non autorizza la cancellazione di produzione.

## 8. Ordine esatto proposto per produzione — nessun passo eseguito

1. **Audit e recuperabilità:** acquisire una copia recuperabile e le definizioni live effettive, compresi writer v56, trigger, FK, viste/funzioni e record migration. Individuare tutte le righe `:current`, anomalie potenzialmente perse e eventi i cui prezzi scalari non coincidono più con gli snapshot puntati. Non ricostruire dati storici inventando prezzi mancanti.
2. **Fermare solo gli ingressi di sync autorizzati:** sospendere temporaneamente cron/coda/manual sync e attendere la conclusione dei run esistenti, evitando due versioni del writer contemporanee.
3. **Pubblicare il writer append-only del repository**, preservando secret/config e filtro egress. Verificare che tutte le POST snapshot usino chiave giornaliera e ignore-duplicates. Non distribuire la migration rolling archiviata.
4. **Eseguire lo script manuale `market-append-only-restore.sql`**, solo dopo il punto 3 e il drain: rimuove il value-update trigger inutile. Conservare il record storico della migration già applicata; documentare l'intervento compensativo. Riconciliare il ledger prima di qualsiasi futuro uso del deploy automatico di migration.
5. **Canary append-only e verifica dati:** usare osservazioni giornaliere realmente nuove; un retry dello stesso giorno può essere correttamente ignorato. Verificare anomalie, eventi, ID distinti e current. Esaminare/riparare separatamente, con autorizzazione e fonti attendibili, gli effetti storici del rolling. Riattivare i sync solo dopo questa verifica; nessun cleanup contestuale.
6. **Eseguire il dry run read-only** con ruolo che vede tutte le righe e salvare aggregati/dipendenze. Confrontare risultati delle RPC e identificare pareggi non deterministici. Verificare la futura esposizione della schema privata: `fpt_retention` non deve essere tra gli schemi API.
7. **Collaudare su clone e approvare il piano concreto:** installare lì `market-snapshot-retention-design.sql`, testare riferimenti concorrenti/lock/timeout e misurare durata e numero candidati. Solo dopo revisione e autorizzazione separata installare le funzioni private live; questa installazione da sola non cancella nulla.
8. **Nuovo dry run della funzione e autorizzazione alla cancellazione:** soltanto dopo tutti i gate, un batch iniziale piccolo, READ COMMITTED, timeout impostato prima della chiamata, commit immediato e verifica current/eventi/RPC. Incrementare il limite solo sulla base delle misure, sempre entro 1000; fermarsi su qualsiasi mismatch o dipendenza nuova. Nessun VACUUM FULL automatico.

**Nessun commit/push/deploy o cambiamento al database live effettuato.**
