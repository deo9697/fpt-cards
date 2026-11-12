# Avvio arcano e reset notifiche del dispositivo

Intervento del 12 novembre 2026 sul branch `fix/push-notifications-2`.

## Avvio

La variante approvata “Sigillo arcano” sostituisce la precedente presentazione iniziale: Blattaman sorridente scontornato, undici carte con il dorso Yu-Gi-Oh!, orbite e particelle viola/oro. Testi: “La tua collection in un’app” e “YEAH BABY LES GOH!”.

Il primo frame conserva logo e sfondo compatibili con lo splash nativo Android. La scena segue il bootstrap effettivo, senza percentuali inventate o attese minime. Una sessione ripristinata mantiene la scena durante membri/dati primari; interfaccia pronta, errore gestito o limite di sei secondi la chiudono. Movimento ridotto supportato. I caricamenti interni conservano gli indicatori già presenti.

Asset locali inclusi nella cache PWA v271:

- `assets/loading/blattaman-arcane.webp`: 640×498, 124424 byte, trasparenza reale. Derivato con ImageGen dall'immagine Blattaman esistente, poi ridimensionato e compresso; nessun riquadro aggiunto.
- `assets/loading/yugioh-card-back.jpg`: 428×614, 44343 byte, scaricato da [YGOPRODeck](https://images.ygoprodeck.com/images/cards/back_high.jpg). Proporzioni conservate.

## Reset notifiche

Impostazioni → Notifiche push → **Reimposta** rimuove la sottoscrizione del browser corrente e il relativo endpoint server, chiude gli avvisi locali e sospende la riconciliazione automatica per quell'account/dispositivo. **Attiva** ricrea la registrazione. Il reset resta sospeso anche alla riapertura e non tocca gli altri dispositivi. Epoch, token catturato e Web Lock conservano le protezioni da logout/cambio account concorrenti.

Il sito non può revocare `Notification.permission`: se Chrome ha già memorizzato Consenti o Blocca, il dialogo nativo non ricompare mediante cancellazione delle righe SQL. Su Android aprire il sito in Chrome → icona accanto all'indirizzo → Autorizzazioni → Reimposta autorizzazioni; poi riaprire la PWA e premere **Attiva**. Controllare anche le notifiche nelle impostazioni Android di Chrome/PWA. Riferimenti: [Guida Chrome Android](https://support.google.com/chrome/answer/3220216?co=GENIE.Platform%3DAndroid&hl=it), [Notification.requestPermission](https://developer.mozilla.org/en-US/docs/Web/API/Notification/requestPermission_static).

## Riscontri e limiti

Il GET pubblico del sito `https://fpt-cards.vercel.app/js/push.js` restituisce ancora il vecchio flag `fpt-push-configured`, senza la riconciliazione Push 2.0 e senza reset; anche l'avvio pubblico è quello precedente. `/api/push-public-key` risponde 200. Il branch pubblicato e la produzione sono quindi distinti: questi controlli non dimostrano il corretto recapito delle notifiche.

Diagnostica SQL aggregata in sola lettura: due sottoscrizioni, una collegata a sessione e una eleggibile; nessuna risposta recente correlabile agli hook nella finestra osservata. Migrazione `20261112133700` presente. Nessuna sottoscrizione di produzione revocata in questo intervento, nessun invio reale, nessuna modifica a SQL/segreti e nessun deploy del codice.

Verifiche locali: `npm run test:push` (11 webhook, 20 gruppi Push 2.0, PostgreSQL PGlite, Chrome con app reale e confini push/Supabase simulati); `npm run test:launch` (320/360/390/412 px e landscape, lifecycle, movimento ridotto e fallback); `npm run test:auth` (autenticazione, sessione ripristinata, PWA/cache e regressioni principali); prestiti 2.1 e idempotenza. Screenshot generati sotto `artifacts/`, esclusi dal deploy.

Resta necessaria una prova fisica Android dopo il rilascio coordinato del codice e la verifica privata della configurazione Vercel: consenso, “Invia prova”, ricezione a PWA chiusa/telefono bloccato e apertura del prestito dal tap. I test locali non certificano FCM, impostazioni del telefono o credenziali di produzione.
