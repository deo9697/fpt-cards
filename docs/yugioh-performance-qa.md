# Latenza del simulatore automatico — 18 novembre 2026

Il percorso verificato è tocco della carta → scelta del motore → API autenticata → stato privato/CAS → aggiornamento del campo, sia nel duello del team sia in Testa mazzo. Le scelte di posizione, materiali e zona restano decisioni del core; non vengono simulate in anticipo nel browser.

## Cause e modifiche

- Ogni input avviava un thread e ricaricava/decomprimeva/verificava l'intero catalogo Lua e carte. Il pool ora mantiene fino a due worker con risorse immutabili già verificate. Ogni job continua a creare un WASM e un duello nativo nuovi, ricostruiti dal transcript persistito. Nessuna partita dipende dal pool: perdita dell'istanza, deploy o timeout consentono il replay dal database. Due richieste concorrenti non condividono il duello.
- Timeout di 20 secondi, incluso il tempo in coda; coda limitata, riciclo dopo 128 job e dopo 120 secondi inattivi. Un errore/timeout termina quel worker e la richiesta non salva uno stato parziale. I worker inattivi non mantengono il processo Node in esecuzione. Il riuso dello stesso WASM è stato escluso: il wrapper fissato conserva callback dopo `destroyDuel`.
- La funzione era eseguita a `iad1`, mentre il progetto Supabase è in `eu-west-3`. Solo `api/yugioh-duel.js` viene spostata a `cdg1`, accanto al database. Le altre funzioni mantengono la configurazione esistente. La configurazione segue le [regioni per funzione di Vercel](https://vercel.com/docs/functions/configuring-functions/region).
- Letture di appartenenza e stato indipendenti procedono in parallelo; la membership resta verificata a ogni richiesta. L'autenticazione non viene memorizzata in cache. I mazzi automatici evitano la lettura dei metadati di stampa inutilizzati dal core. Il CAS personale restituisce soltanto ID/versione/timestamp, evitando di rileggere lo stato appena scritto; il servizio ricompone la vista dai dati che ha salvato.
- Durante `autoRespond` il browser aggiorna soltanto stato di attesa e controlli disabilitati. Campo e immagini rimangono montati fino alla risposta, poi avviene un solo render completo. Restano attivi i controlli di uscita/orientamento e le protezioni da doppio tocco, prompt obsoleti, conflitti ed errori. La reference del campo viene rilasciata all'uscita.
- `Server-Timing` espone soltanto durate anonime `total`, `auth`, `db`, `engine`. Le letture DB parallele contano il tempo effettivo condiviso, senza sommare due volte la sovrapposizione. Nessun token, nome, ID, seed o contenuto della partita entra nell'header.

## Misure locali prima/dopo

| Prova ripetibile | Prima | Dopo |
|---|---:|---:|
| 40 input TCG reali: mediana worker | 444,3 ms | 24,1 ms |
| Stessi input: p95 worker | 517,6 ms | 28,5 ms |
| Primo avvio worker | circa 450 ms | circa 450 ms |
| Browser CPU 4×: mediana tocco → invio fetch | 19,4 ms | 1,3 ms |
| 19 richieste: render completi | 51 | 32 |
| Stesso percorso: CPU totale di render | 1743 ms | 966 ms |
| HTTP locale con storage in memoria: mediana | 547 ms | 72,5 ms |

Il risultato del replay è confrontato con la ricostruzione diretta: stessi prompt, viste, effetti e transcript. Le misure worker escludono rete, autenticazione, database e avvio del contenitore Vercel. Il benchmark browser usa Chrome, touch e CPU rallentata 4× su viewport 844×390 e 740×360; i tempi HTTP locali non rappresentano la latenza di produzione o di ogni telefono. La prima inizializzazione mantiene un costo maggiore delle mosse successive.

## Ripetizione e copertura

`npm run test:yugioh-auto-performance` verifica pool, isolamento, coda, scadenze, crash/exit, messaggi obsoleti, riciclo, CAS minimale, round trip, privacy, header e busy UI. È incluso nella suite automatica completa. Le suite dei duelli e della prova personale verificano gli effetti reali, il packaging isolato, i due client, tocchi, orientamento, ripresa e riavvio.

Benchmark separati dalle regressioni, senza soglie legate alla velocità della macchina:

```sh
node scripts/yugioh-auto-performance-bench.mjs
node scripts/yugioh-auto-client-performance.mjs
```

Report locali in `artifacts/yugioh-auto/performance-{before,after}-pool.json` e `artifacts/yugioh-auto-client-performance/{baseline,after}.json`. La verifica live controlla versione PWA, hash dei file, header di autenticazione e regione effettiva senza creare partite o notifiche di produzione.
