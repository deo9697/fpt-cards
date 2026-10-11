# Market egress — istruzioni operative del pacchetto

Questo pacchetto sostituisce il piano cron del report precedente del 4 ottobre.
Stato iniziale fornito dall'utente: progetto gonycawupahawocqafcf, worker v57
append-only, job 5/6 pausati, zero run attivi. NON riverificato sul remoto in questo task.
La preparazione non ha effettuato deploy, SQL remoto, chiamate Edge live, accessi a
secrets o modifiche cron. Il test guest estraneo al P0 non è un blocker del pacchetto.

## Fonte canonica e payload

Unica definizione eseguibile di `market_refresh_queue_pending()`:
`supabase/manual/market-feed-queue-probe.sql`. Le copie nel bundle e nei blocchi
Markdown sono generate da quella fonte, non altre migration da applicare.
Il worker e il wrapper condividono una policy inline verificata identica dal test.
La vista `market_monitored_printings` è SECURITY INVOKER: i grant includono anche
le quattro tabelle sottostanti. Solo SELECT al backend; nessun grant frontend.

Daily esatto: `{"mode":"daily_full","scheduled":true,"pricesOnly":true,"recoverStale":true}`.
Tutti i parametri sono consumati. `source` non è necessario e viene omesso.
`pricesOnly:true` salta il resolver e il catalogo anche con mapping irrisolte;
quelle restano pending fino a un job resolver amministrativo esplicito.
Il nuovo daily non pretende di risolvere nuove mapping senza catalogo.
`scheduled:true` aggiunge la guardia Edge alle 03 Europe/Rome; il comando SQL ha
la stessa guardia. `0 1,2 * * *` UTC produce una sola chiamata effettiva al giorno,
compresi i cambi DST. La queue conserva `5,20,35,50 * * * *`.

## F. TEST RESULT

Eseguiti offline con Node v22.13.0 (`C:\Program Files\nodejs\node.exe`):

```powershell
node scripts/market-feed-hardening-smoke.mjs
node scripts/market-egress-rollout-smoke.mjs
node scripts/market-snapshot-retention-smoke.mjs --strict
Get-ChildItem scripts -Filter 'market-*-smoke.mjs' | ForEach-Object { node $_.FullName; if ($LASTEXITCODE) { throw $_.Name } }
git diff --check
```

Risultati: 24/24 suite Market PASS, incluse le due suite egress e strict retention.
Il preview server locale è necessario per i test browser (`node scripts/preview-server.mjs`).
Il test hardening è stato rieseguito dopo il passaggio alla vista invoker reale con RLS.
Test nuovi: exact daily prices-only, zero catalogo anche con unresolved, queue/auth,
nessun import GitHub, singolo bulk e nessun retry, permessi RPC effettivi, timestamp
concorrente protetto su PostgreSQL/WASM; cron rollout/rollback e canary SQL eseguiti
con stub pg_cron/pg_net locali, schedules/guardia DST reali. Nessun pg_net remoto.
`git diff --check` PASS (solo warning CRLF). Nessun test guest/UI estraneo cambiato.

## G. EXACT LIVE ROLLOUT ORDER

1. Eseguire H1 del file verification. Confermare IDs/nome/schedule, entrambi PAUSED,
   zero run attivi, timezone cron UTC/GMT, un solo secret Vault non vuoto. Verificare
   anche che vecchie richieste pg_net non siano ancora in volo: un cron pausato non
   cancella richieste già accodate. Attendere il completamento/timeout, non cancellarle.
   Salvare come backup il sorgente attuale v57 e la configurazione dei due job
   tramite gli strumenti di lettura autorizzati al momento del rollout. Non stampare secrets.
2. Confermare ancora active sync runs = 0 subito prima delle modifiche.
3. Applicare SOLO `supabase/manual/market-feed-queue-probe.sql`. Eseguire H2:
   invoker, boolean, grant backend, BYPASSRLS service_role già esistente, probe boolean.
   Se non concordano, fermarsi con cron pausati; non aggiungere grant anon/auth.
4. Deploy `market-sync` dal file COMPLETO incluso nel bundle, `verify_jwt=false`.
5. Deploy `market-refresh-queue-cached` dal file COMPLETO incluso, `verify_jwt=false`.
   Usare le env esistenti, nessun set secrets. Leggere metadata/sorgenti appena
   distribuiti: confrontare col manifest e accertare che il wrapper non importi GitHub.
   Il secret gate HTTP resta obbligatorio; JWT disattivato non rende anonima la funzione.
6. Eseguire `market-egress-cron-rollout.sql` fino alla SELECT finale. Il file intero
   lascia i job pausati: REACTIVATE è commentato intenzionalmente. Controllare endpoint,
   schedule, guardia e payload. Non usare schedule/unschedule o creare altri job.
7. Eseguire UNA volta `market-egress-queue-canary.sql`; annotare il request ID restituito.
   Commit prima della lettura risposta: pg_net invia dopo commit.
8. In una nuova query H3, trovare quell'ID: HTTP 200, `ok:true`, `mode:queue_targeted`,
   status `skipped`/`deferred`, reason `queue_empty`/`awaiting_daily_full`.
   Nei log della stessa invocazione: `market_sync_feed_bytes=0`,
   `market_sync_storage_bytes_read=0`, cache counters 0 e un solo probe boolean.
   Nessun nuovo sync run e nessun acknowledgement. HTTP 503/401, risposta assente,
   log assenti o provenienti dalla vecchia versione => NON riattivare.
9. NON invocare un daily manuale in questo rollout. La chiave giornaliera e
   ignore-duplicates impediscono duplicati, ma non il secondo download né un run
   parziale nello stesso giorno. Il primo daily reale è il canary prezzi. Attendere
   il prossimo slot 03:00 Europe/Rome; non forzare `scheduled:false` né recover ripetuti.
10. Dopo canary queue positivo, eseguire separatamente:
    `select cron.alter_job(job_id:=5, active:=true);`
11. Poi: `select cron.alter_job(job_id:=6, active:=true);`
    Eseguire la SELECT stati in H4. Nessun altro job riattivato.
12. Ispezionare primo polling e primo daily con H4 + log Edge: zero feed queue;
    daily massimo un Price Guide, nessun catalogo, cache bypass, Storage zero;
    snapshot giornalieri, current avanzato, nessun :current nuovo/duplicato/evento
    con ID uguali. Anomalie/eventi possono legittimamente essere zero se l'input
    non li richiede: non generare osservazioni sintetiche live. Un run partial/failed
    richiede lettura dell'errore prima di recovery; non attivare retry automatici.

Deploy tramite CLI, se è lo strumento scelto dall'operatore (comandi NON eseguiti qui):

```sh
supabase functions deploy market-sync --project-ref gonycawupahawocqafcf --no-verify-jwt
supabase functions deploy market-refresh-queue-cached --project-ref gonycawupahawocqafcf --no-verify-jwt
```

Sono equivalenti a due deploy MCP degli stessi file con `verify_jwt:false`.
Non applicare tutte le migration del repository. Nessun cleanup/Storage retention.
Firma alter_job verificata su [pg_cron ufficiale](https://github.com/citusdata/pg_cron#altering-a-cron-job);
opzione deploy documentata da [Supabase](https://supabase.com/docs/guides/functions/deploy).

## Rollback code / cron / safe-stop

- SAFE-STOP: eseguire solo il primo blocco PAUSE del file rollback. Nessun restore
  di dati; lasciare le nuove funzioni deployate ma non schedulate.
- Rollback cron: file completo `market-egress-rollout-rollback.sql`, sempre PAUSED.
  Ripristina gli URL/body/guardia/schedule precedenti forniti dall'utente. Non
  riattiva automaticamente la pipeline Storage pericolosa.
- Rollback code: dopo stop e drenaggio richieste ripristinare il backup v57 salvato
  al punto 1 e, solo se serve riprodurre il vecchio daily, il wrapper v2 archiviato
  nel bundle. Quel wrapper scarica di nuovo il worker remoto pinnato: lasciare
  entrambi i cron pausati fino a una scelta esplicita. Non confondere il diff locale
  rispetto a Git HEAD con un backup verificato del deploy v57.
- La RPC invoker può restare installata/inutilizzata: niente DROP, niente restore
  di tabelle, nessuna modifica a trigger/migration record/retention.

## I. SAFE TO DEPLOY = YES

YES per il pacchetto coordinato con l'ordine e i gate sopra, non per il solo wrapper.
Non restano blocker locali del P0. I controlli live sono passi del rollout, NON
risultati già osservati in questa preparazione. Se un gate fallisce, mantenere PAUSED.
Non viene dichiarato testato un deploy remoto o un feed reale sotto quota Free.
