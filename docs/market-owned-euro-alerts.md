# Avvisi prezzo sulle carte possedute

Richiesta del 12 novembre 2026: soglia scelta **almeno 2 €**, in salita e in discesa, senza criterio percentuale.

## Comportamento

- Solo printing presenti nella propria raccolta con quantità positiva; né carte soltanto osservate né carte di altri membri.
- Differenza sul prezzo unitario di riferimento Cardmarket, non moltiplicata per le copie. `10 → 12 €` e `10 → 8 €` notificano; `0,10 → 2,09 €` non notifica.
- Confronto con il rilevamento giornaliero precedente dello stesso prodotto/mapping, tipo di prezzo, valuta EUR, lingua, condizione, foil e scope. Finestra storica 20–48 ore per tollerare ora legale e ritardi del sync; ultimo prezzo non più vecchio di 36 ore.
- Stesso ordine di preferenza del prezzo mostrato da Market Watch (`market_reference_type`). Non somma cambiamenti minori avvenuti in giorni diversi.
- Prezzi anomali, stime minime tra varianti ambigue, cambi di prodotto/variante senza uno storico confrontabile e dati futuri non generano alert.
- Massimo un avviso ogni 24 ore per membro e printing; ripetizioni dello scan o dello stesso snapshot non duplicano la notifica. Carte diverse hanno cooldown indipendenti.
- Il primo scan registra solo i cursori, evitando un invio dell'arretrato. Anche una carta appena aggiunta/riacquistata viene inizializzata senza avviso storico.
- Eventuali preferenze pregresse possono disabilitare, limitare il verso o alzare la soglia/cooldown; non possono abbassare il minimo di 2 € né attivare tramite percentuali.

Esempio: titolo “Drago Bianco Occhi Blu”, testo “Prezzo salito: 12,00 € → 14,50 € (+2,50 € per carta).” Il tap apre quella printing nella propria Raccolta, con il prezzo aggiornato, anche passando prima dal login e anche se non è nella prima pagina di Market Watch. Il gioco viene ricavato dai dati posseduti, non dal parametro del link.

## Implementazione e rilascio

`supabase/manual/market-owned-euro-alerts.sql` sostituisce `run_market_alert_scan()` e il gate esistenti, aggiungendo un cursore separato dalle preferenze per ogni membro/printing. Tabelle con RLS e nessun accesso client; scan e gate eseguibili soltanto da service_role/postgres, search_path vuoto e advisory lock transazionale. Il cursore non ha FK allo snapshot per sopravvivere alla retention dello storico; le FK a membro e printing cancellano gli stati al loro venir meno.

La cache del guscio PWA passa a v272 per distribuire il nuovo routing. La produzione è stata esaminata **solo in lettura**: esistono vecchie funzioni di scan con soglie percentuali e watchlist, ma manca il relativo job cron, non ci sono preferenze né notifiche market. Il trigger su `notifications` è già la sorgente delle push. Non serve un secondo inviatore, né cambiare segreti/webhook.

Ordine per un rilascio autorizzato:

1. Revisionare/applicare `supabase/manual/market-owned-euro-alerts.sql` (nessuno scan né cron viene avviato dal file).
2. Rilasciare insieme il routing frontend aggiornato e Push 2.0, verificando la configurazione privata Vercel indicata nell'audit push.
3. Eseguire `supabase/manual/market-owned-euro-alerts-enable.sql`: inizializzazione senza arretrato su stato vuoto e job idempotente alle **04:00 Europe/Rome**, dopo il sync. Da questo momento gli INSERT futuri possono spedire push reali.

Stop reversibile senza cancellare dati: `select cron.unschedule(jobid) from cron.job where jobname='fpt-market-alert-daily-gate';`. Per ripristinare le vecchie funzioni, fermare prima il job e usare le definizioni precedenti di `supabase-market-alert-scan.sql`; i nuovi cursori possono restare inerti. Non riattivare lo scan precedente aspettandosi la nuova soglia in euro.

La prima implementazione è stata verificata soltanto in locale, senza SQL/job/deploy o invii reali. Il successivo rilascio completo in produzione è stato autorizzato dall'utente il 12 novembre 2026: la procedura sopra descrive l'ordine di applicazione e attivazione. I riscontri operativi vengono conservati nel report locale del rilascio.

## Verifica

- `npm run test:market-alerts`: SQL reale in PostgreSQL PGlite, applicazione ripetuta, confini 1,99/2,00 €, rialzo/ribasso, quantità, identità, freschezza, anomalie, cooldown, proprietà e autorizzazioni; Chrome con app reale e confini Supabase/Push simulati per tap caldo, nuovo login, cold start completo e link estraneo.
- `npm run test:auth`: regressioni principali di autenticazione, raccolta, prestiti, PWA e cache.
- Screenshot telefono del dettaglio generato in `artifacts/push-notifications-2/phone-owned-price-alert.png`, escluso dal deploy.

Restano da collaudare su Android fisico dopo il rilascio: ricezione con PWA chiusa/telefono bloccato, tap reale e impostazioni OS. Accettazione lato push service e test sintetici non dimostrano visualizzazione sul telefono.

Riferimenti consultati: [trigger Postgres Supabase](https://supabase.com/docs/guides/database/postgres/triggers), [changelog Supabase](https://supabase.com/changelog.md). Le caratteristiche specifiche dell'app derivano dal codice e dall'audit in sola lettura.
