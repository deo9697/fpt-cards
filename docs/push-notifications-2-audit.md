# F.P.T. Cards — Push Notifications 2.0

Audit e implementazione del 12 novembre 2026. SQL applicato in produzione dopo autorizzazione (migrazione `20261112133700_push_notifications_2_session_binding`), senza alterare le righe push esistenti: riscontro in `docs/audit-snapshots/push-notifications-2-prod-apply.json`. **NOT READY FOR DEPLOY** fino a verifica privata Vercel e collaudo fisico. Nessun deploy del codice, invio a membri reali o modifica di segreti eseguito.

1. **Cause e riscontri verificati**

   - `pushConfigured()` leggeva soltanto `fpt-push-configured`: poteva mostrare Attive senza permesso, sottoscrizione o registrazione valida. Mancavano riconciliazione al login e riparazione automatica.
   - Entrambi gli endpoint ignoravano gli errori di invio e contavano tutte le righe come notifiche inviate. Nessuna distinzione tra assenza di dispositivi, 404/410, errori VAPID e rete.
   - Il logout non disiscriveva il browser né rimuoveva il collegamento server. La registrazione leggeva il token corrente dopo operazioni asincrone, senza identità catturata o invalidazione.
   - `send-push` non gestiva l'approvazione/rifiuto di una richiesta. I prestiti portavano alla radice, senza identificativo; l'apertura nelle finestre esistenti perdeva parametri o ignorava il link prima del login.
   - `send-notification-push` indicava l'icona a colori anche come badge. Il Service Worker usava già il badge monocromatico corretto; ora resta l'unica fonte per gli asset di sistema.
   - Il Service Worker poteva mettere in cache risposte `/api/`, inclusa la chiave pubblica. Ora le esclude e usa una nuova versione della cache del guscio.
   - Produzione, verifiche **in sola lettura**: tabella push con RLS attiva, nessuna policy diretta; 2 endpoint per 2 membri; aggiornamenti del 9 novembre. Trigger `fpt-web-push` INSERT/UPDATE su loans e `notification-push` INSERT su notifications presenti, diretti al dominio previsto, con header secret presente. Il secondo non specifica Content-Type, ma la funzione `net.http_post` installata imposta il tipo JSON: non è dimostrata una rottura dovuta a questo header. Le notifiche persistite osservate appartengono alla categoria share_request. Entrambi i membri con push hanno una sessione applicativa viva; nessuno ha un?identit? Auth associata e il pilot di identit? ? disabilitato (0 abilitati).
   - GET pubblico `/api/push-public-key`: **200**, chiave presente di 87 caratteri; valore non riportato. Non dimostra che la coppia privata/pubblica sia corretta.
   - Nessuna risposta push recente era correlabile agli hook nella finestra disponibile. I 200 generici di pg_net non provano una consegna. La causa precisa di ciascun mancato recapito storico non è ricostruibile dai dati disponibili.

2. **File modificati o aggiunti per questo intervento**

   - `js/push.js`, `js/api.js`: ciclo di vita e chiamate autenticate.
   - `app.js`, `styles.css`: onboarding, impostazioni, identità, link a prestiti/richieste.
   - `sw.js`: cache v270, branding, privacy, routing sicuro, segnale di riparazione su pushsubscriptionchange.
   - `api/send-push.js`, `api/send-notification-push.js`, `api/push-public-key.js`: endpoint esistenti aggiornati.
   - Nuovi `api/_push-delivery.js`, `api/test-push.js`: invio condiviso e prova autenticata.
   - Nuovo `supabase/manual/push-notifications-2.sql`: rollout SQL applicato in produzione dopo autorizzazione. Aggiunto `supabase/manual/push-notifications-2-prod-rollback.sql` con le definizioni e i grant precedenti, senza dati o segreti.
   - Nuovi `scripts/push-notifications-2-smoke.mjs`, `scripts/push-notifications-2-sql-smoke.mjs`, `scripts/push-notifications-2-browser-smoke.mjs`; script `test:push` in `package.json`. In `scripts/auth-regression-smoke.mjs` il controllo banlist dopo hard refresh attende ora il caricamento asincrono del metadata, mantenendo la stessa asserzione e il timeout della suite.
   - Questo report e screenshot locali in `artifacts/push-notifications-2/`.
   - `api/_webhook-auth.js` e i file SQL storici sono stati controllati senza modificarli. Le modifiche preesistenti al simulatore e agli altri file sono state conservate. Nessun nuovo logo o asset di branding creato.

3. **Comportamento implementato**

   - Onboarding su Home e Prestiti dopo l'accesso; Attiva avvia il prompt nativo direttamente dal click. Non ora rinvia per sette giorni per membro. Nessun prompt nativo automatico.
   - Controllo reale di API, HTTPS, permesso, sottoscrizione, scadenza e chiave VAPID. Riutilizzo della sottoscrizione esistente; riparazione automatica al login, ripristino e ritorno in primo piano quando il permesso è già concesso. Nessuna fiducia nel vecchio flag.
   - Operazioni concorrenti accorpate, Web Locks quando disponibili, token e membro catturati. Il server controlla il membro atteso e serializza la registrazione con l'invalidazione della sessione. Endpoint univoco, collegamento alla sessione; invio soltanto per sessioni vive e membri attivi.
   - Logout con cancellazione del collegamento, unsubscribe e chiusura delle notifiche. Cambio sessione in altra scheda invalida il vecchio stato locale senza sovrascrivere l'account salvato dall'altra scheda. Push già accodate per un altro account mostrano un messaggio generico, senza testo privato.
   - Icona ufficiale `/icon-192.png`, badge esistente `/assets/notification-badge.png`, vibrazione, testi con dati effettivi e nomi letti dal database; fallback allo slug reale. Nessuna immagine carta opzionale aggiunta. Tag stabili e `renotify:false` sostituiscono notifiche duplicate presenti nel centro notifiche; non viene promessa una semantica exactly-once dopo la loro rimozione.
   - Richiesta, approvazione, rifiuto e restituzione con destinatario e link al prestito. Richieste dalla raccolta conservano requestId, selezionano il tab coerente e scorrono alla richiesta. Il link al prestito sopravvive al login. URL di sistema esterni all'origine bloccati.
   - Impostazioni con stato verificato, attivazione/riparazione, istruzioni per permesso negato e installazione iOS, prova sul solo endpoint posseduto dalla sessione corrente. Limite persistente di una prova al minuto per endpoint, verificato atomicamente sul database; nessun destinatario arbitrario nel percorso di prova.
   - Risposte senza sottoscrizioni: 409 `no_subscriptions`; tutte scadute: 410 `subscriptions_expired`; errori di invio: 502 con codici VAPID/rete/servizio; configurazione VAPID non valida: 503. 200 `push_service_accepted` indica solo accettazione del servizio, non visualizzazione sul telefono. Gli eventi irrilevanti restano esplicitamente ignored.
   - Pulizia 404/410 condizionata anche alle chiavi, per non cancellare una registrazione rinnovata nel frattempo. Errori restituiti come codici senza endpoint, chiavi, token o dettagli del provider.

4. **Test eseguiti**

   - `npm run test:push`: **PASS**. Comprende 11 controlli webhook esistenti, 17 gruppi Push 2.0, test PostgreSQL PGlite e 8 gruppi nel vero Chrome con viewport telefonico. Confini Supabase/Push simulati, nessun invio reale.
   - Push 2.0: prima attivazione; granted/denied/unsupported; iOS installato/non installato simulato; Non ora; flag obsoleto; sottoscrizione esistente/mancante/scaduta; riconciliazione concorrente; logout e cambio account durante operazioni pendenti; errore di registrazione; eventi prestito; tag duplicati; payload e link delle richieste; VAPID/rete/410; prova autenticata e rate limit; privacy, branding, routing e API fuori cache nel worker.
   - PostgreSQL locale: applicazione ripetibile dello SQL, RLS e grant, identità attesa, endpoint univoco, prova solo sul proprio dispositivo, rate limit persistente, trasferimento account, pulizia con vecchio token innocua, logout, rifiuto registrazioni tardive, esclusione di sessioni scadute, blocco endpoint estranei e compatibilità RPC a quattro argomenti.
   - Chrome: app reale, cold link → login → prestito corretto; onboarding senza prompt automatico; Non ora; impostazioni leggibili a 360/390 px; attivazione/riparazione/prova; warm click; logout; nuovo account senza ripetere il prompt; invalidazione dopo cambio sessione in altra scheda. Nessuna eccezione non gestita. Screenshot ispezionati e impaginazione corretta dopo la prima verifica.
   - Regressioni: `auth-regression-smoke.mjs`, `collection-loans-2-1-smoke.mjs`, `loan-request-idempotency-smoke.mjs`, `collection-share-requests-state-machine-e2e-smoke.mjs`, `onepiece-simulator-routing-smoke.mjs`: **PASS**. La suite auth verifica anche Service Worker reale e cache PWA. Il primo giro aveva rilevato l'aumento di altezza della Raccolta causato dall'onboarding: corretto limitando il banner alle schermate pertinenti, poi suite ripassata. Un ulteriore giro ha individuato una race nel test banlist del mazzo (assert immediata prima del completamento del metadata): ora attende il badge atteso e fallisce se non compare entro il timeout.
   - Controllo sintassi JavaScript e `git diff --check`: PASS.

5. **Passi Supabase/Vercel necessari prima del rilascio**

   - `supabase/manual/push-notifications-2.sql` già applicato in produzione dopo autorizzazione. Richiede la tabella push e il sistema esistente app_sessions; conserva la RPC precedente a quattro argomenti. Aggiunge due colonne, RPC per revoca, selezione dispositivi vivi e prova atomica; aggiorna save e logout. Non ricrea trigger e non modifica segreti.
   - Verificare su Vercel Production `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `PUSH_WEBHOOK_SECRET` e l'eventuale NEXT, senza copiarli in report/log. Il connettore disponibile ha risposto 403 per il proprio scope: configurazione privata e corrispondenza dei secret non verificate. Non è stata avviata alcuna rotazione.
   - Resta da coordinare il futuro deploy del codice. I vecchi endpoint non vengono cancellati. Quando il nuovo backend entra in servizio, le righe prive di session_token_hash non sono eleggibili finché il membro riapre l'app aggiornata e la riconciliazione le collega alla sessione. Informare i membri di riaprire la PWA.
   - Eseguire una prova autorizzata dal proprio dispositivo e controllare i codici degli hook nei log di Vercel/pg_net. Collaudare richiesta, approvazione/rifiuto, restituzione e raccolta condivisa con account di test concordati. Non utilizzare membri reali senza autorizzazione.
   - Ripristino: coordinare sempre codice e SQL. Ripristinare le definizioni precedenti di save_push_subscription (dal file storico) e logout_member, revocare/rimuovere le nuove RPC se necessario; le due colonne aggiuntive possono restare, senza eliminare dati. Non ripristinare solo il backend ignorando le modifiche alla sessione.

6. **Problemi e limiti ancora aperti**

   - Nessun collaudo su Android o iPhone fisici: ricezione a PWA chiusa, lock screen, impostazioni OS, grafica nativa e tap reali non certificati.
   - Su iOS/iPadOS le push richiedono un contesto Home Screen compatibile e un gesto esplicito; il test iOS qui è una simulazione delle capacità, non Safari reale. Riferimento: [WebKit](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/).
   - Un worker privo di client aperti non conserva credenziali di sessione. Una sottoscrizione cambiata viene riconciliata alla successiva apertura autenticata; l'evento pushsubscriptionchange avvisa subito i client aperti. La compatibilità di questo evento varia per browser.
   - Nessun sistema di ricevute dal dispositivo o coda durevole di retry aggiunto. Le anomalie sono ora distinguibili e i tag limitano i duplicati visibili, ma Web Push e webhook non garantiscono consegna o visualizzazione exactly-once.
   - Le notifiche richiedono una sessione applicativa valida: scadenza o revoca interrompono gli invii fino al nuovo accesso. Il flusso target è l'accesso membri F.P.T. con token applicativo; eventuali sessioni esclusivamente Supabase Auth senza app_sessions richiedono una successiva integrazione dedicata e non sono certificate da questo rollout.
   - Branch dedicato `fix/push-notifications-2` creato con i permessi necessari, dopo il primo tentativo limitato dal sandbox. Modifiche Push 2.0 isolate per il commit e push autorizzati sul branch; interventi preesistenti al simulatore e altri file conservati nel workspace. Verificata anche una copia esatta dei file preparati per il commit: suite push, autenticazione/PWA, prestiti e idempotenza superate.

7. **Valutazione**

   Implementazione, test locali e applicazione SQL in produzione completati. **NOT READY FOR DEPLOY** fino a verifica privata di Vercel e test fisici autorizzati. Nessun deploy del codice effettuato.

Riferimenti tecnici consultati: [Supabase RPC](https://supabase.com/docs/reference/javascript/rpc), [Supabase changelog](https://supabase.com/changelog.md), [PushManager.subscribe](https://developer.mozilla.org/en-US/docs/Web/API/PushManager/subscribe). L'audit del progetto deriva dal codice e dalle interrogazioni aggregate in sola lettura, non da ipotesi sui servizi in produzione.
