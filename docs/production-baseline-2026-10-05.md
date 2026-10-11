# FPT Cards — baseline di stabilizzazione, 5 ottobre 2026

Audit e fix locali dello sprint P0/P1. Nessun deploy, modifica DB/cron/secrets,
cleanup, Storage delete, VACUUM, commit o push effettuato in questo sprint.
Le operazioni live del rollout precedente sono distinte dalle letture di oggi.

**Esito:** regressioni locali corrette, 57/57 suite pertinenti passate.
Restano aperti la ricostruzione storica dell'ingest MAMO, la revisione delle
printing mancanti e la riconciliazione della cronologia migration. Questo
documento non autorizza un rollout né una riparazione massiva.

**1. Baseline e drift**

HEAD: `092901e453678c07775344a474906975654f9ca3`.
Il working tree conteneva già modifiche Market, auth/User Edition, frontend,
documentazione, migration e numerosi file non tracciati. Sono stati preservati.
Inventario completo, ultimi 10 commit, diffstat, diffcheck e confronto hash:
[baseline.json](audit-snapshots/production-stabilization-2026-10-05/baseline.json).

| Component | Repo state (HEAD) | Local state | Known live state | Drift | Risk |
|---|---|---|---|---|---|
| Market worker | Versione precedente all'hardening locale | Append-only, guard daily, pricesOnly, misure byte | VERIFIED LIVE: v58 ACTIVE, sorgente identica al locale | HEAD arretrato | Alto: deploy da HEAD potrebbe perdere l'hardening |
| Queue wrapper | Non tracciato in HEAD | Worker autonomo, RPC boolean, defer senza feed | VERIFIED LIVE: v3 ACTIVE, sorgente identica al locale | File locale non committato | Alto: ripristino del vecchio import GitHub |
| RPC queue | SQL manuale locale | SECURITY INVOKER, backend soltanto | VERIFIED LIVE: boolean, search_path vuoto, timeout 10s; anon/auth senza EXECUTE, service_role autorizzato | Live migration `20261004074139`, SQL canonico in manual/ | Non applicare doppie migration |
| Cron 5/6 | Storico non rappresenta lo stato corrente | Pacchetto rollout preservato | VERIFIED LIVE: entrambi PAUSED | Rollout precedente interrotto dopo canary | Prezzi non aggiornati automaticamente finché pausati |
| Snapshot rolling | Report/migration storici presenti | Writer append-only | VERIFIED LIVE: 0 chiavi :current, trigger UPDATE rimosso, record storico conservato | Rimozione runtime distinta dal record storico | Non ripristinare la migration archiviata |
| Catalogo YGO | Resolver perdeva righe con card_sets incompleto; limite 8 | LOCAL ONLY: fallback dalla riga set, nessun limite totale, errori espliciti, niente cache negativa permanente | VERIFIED LIVE: 3.214 printing; MAMO-EN013 corretta manualmente | Fix JS non distribuito; catalogo non esaustivo | OCR valido può non trovare una printing |
| One Piece | Modello separato esistente | Nessuna modifica | VERIFIED LIVE: 5.537 printing | Nessuna nuova verifica di ingest/scanner OP | Fuori scope P2 |
| Fast Scan | NOT_FOUND aggregava cause diverse | LOCAL ONLY: diagnostica distinta e priorità I/1/L nel numero | Nessun deploy frontend | Codice locale più recente | Verifica camera reale ancora necessaria |
| Shared guest | Debounce, cap 60 e lazy image già presenti | LOCAL ONLY: indice testo, cache sort/filter, delegation, in-flight dedupe | Frontend live non confrontato | Benchmark e fix locali | Download completo e DOM crescono con Load more |
| Migration | File timestampati + SQL root/manuali | Nessuna nuova migration | VERIFIED LIVE: cronologia esportata | 63 versioni live senza file di pari versione; 53 locali senza record di pari versione | BLOCKING per db push indiscriminato |
| Documentazione | README descrive ancora raccolta come non applicata | Questo documento è la baseline attuale | Tabelle/funzioni esistono già | Report Market del 4 ottobre descrivono fasi precedenti | Non usare report storici come stato corrente |

Il confronto migration riguarda **versioni**, non prova 116 differenze di schema:
alcune operazioni hanno nomi simili, timestamp diversi o SQL fuori migrations/.
Occorre confrontare i corpi prima di decidere una riconciliazione. Nessun repair
della history, reset, rename o db push è stato eseguito.

**2. Cause trovate e comportamento corretto**

- VERIFIED IN REPO: il vecchio wrapper Market importava un worker remoto e poteva
  scaricare tutti i target anche a queue vuota. L'hardening precedente è conservato.
- VERIFIED IN REPO / riprodotto prima del fix: `lookupPrintingBySetCode` usava
  soltanto `cardinfo.card_sets`, pur avendo una printing valida nel set endpoint.
  Una risposta incompleta del secondo endpoint produceva zero risultati.
- VERIFIED IN REPO: risultati vuoti erano memorizzati per tutta la sessione;
  `slice(0,8)` scartava eventuali identità successive. Ora si elaborano tutte le
  righe in gruppi da 8, senza inventare rarità, immagini o identità.
- LOCAL ONLY: una riga senza identità/rarità utilizzabile fallisce esplicitamente;
  errori di rete/HTTP 5xx non diventano risultati catalogo vuoti. 400/404 restano
  miss dell'endpoint con possibilità di fallback locale→EN.
- VERIFIED IN REPO / riprodotto dal corpus: la correzione numerica I/1 e L/1
  finiva dopo i primi candidati interrogati. La priorità è ora più alta nel
  suffisso numerico; soglie di accettazione, ambiguità e review restano invariate.
- VERIFIED IN REPO: il guest rinormalizzava i campi e riordinava gli item a ogni
  ricerca, aggiungendo listener per ciascuna riga dopo ogni render della griglia.

**3. Market — stato e test**

VERIFIED LIVE: `market-sync` v58 e `market-refresh-queue-cached` v3, entrambi
ACTIVE e `verify_jwt=false`; i controlli del secret restano nel codice.
Hash delle sorgenti, normalizzando soltanto newline/fine file, identici al locale.
Cron timezone GMT, run attivi 0, snapshot rolling 0, trigger value UPDATE 0.

| Job | Nome | Schedule GMT | Stato |
|---|---|---|---|
| 5 | fpt-market-refresh-queue | `5,20,35,50 * * * *` | PAUSED |
| 6 | fpt-market-sync-daily | `0 1,2 * * *` | PAUSED |

Il comando daily del pacchetto applica la guardia delle 03:00 Europe/Rome.
Canary precedente 3027: HTTP 200, non timed out,
`deferred / awaiting_daily_full / queue_targeted`. Oggi non è stato reinvocato.
Questo è un esito HTTP, non una nuova misura live dei byte.

LOCAL ONLY / test: queue vuota e pending senza feed/catalogo/Storage; daily al
massimo un Price Guide, niente Product Catalogue con pricesOnly, niente retry
bulk; niente import GitHub runtime o chiavi rolling. Writer con chiavi
`mapping_id:YYYY-MM-DD` e `resolution=ignore-duplicates`.
24/24 Market smoke PASS; retention strict prova INSERT anomalo, eventi con ID
precedente/corrente distinti, avanzamento current, dedupe giornaliero, chart
trend/reference e protezione FK/current/events durante retention sintetica.
Il pacchetto rollout `--check` passa, inclusi 10 file canonici e manifest SHA-256.
Nessun cambiamento alla retention, nessuna stima cleanup live nuova.

**4. Catalogo e MAMO**

Fonte: API YGOPRODeck già usata dal progetto, richiesta limitata al set
[Magnificent Monsters](https://db.ygoprodeck.com/api/v7/cardinfo.php?cardset=Magnificent%20Monsters).
Copia locale con 126 card source. Le sole printing `MAMO-` producono 228 identità
codice/ID/rarità, confrontate con 65 righe live. Risultati:

- 163 identità source assenti nel DB, da verificare; non equivalgono automaticamente
  a 163 inserimenti approvati né a 163 artwork fisici distinti.
- La fonte copre 126 codici MAMO distinti: 61 non hanno alcuna riga DB; gli altri
  finding riguardano identità/rarità aggiuntive su codici già rappresentati.
- 64 righe prive di `source_provider`; tutte le 65 risultano catalog verified.
  Lo stato verified non prova completezza del set o copertura di tutte le varianti.
- Nessun altro tipo di finding nel sottoinsieme esportato. L'audit implementa
  controlli ID mancanti, duplicati incoerenti/identità fisica, rarità non presenti
  nella fonte, set name, immagini, verifica e gap numerici solo informativi.
- L'audit eseguito è esaustivo per le identità MAMO della fonte acquisita, **non**
  per l'intero catalogo YGO. Lo script accetta altri export e un prefisso esplicito
  (stringa vuota per tutti i codici); non accede alla rete né scrive nel DB.

Report per codice, nome, catalog ID, rarità, varianti note, presenza/conteggio DB
e verifica: [CSV MAMO](audit-snapshots/production-stabilization-2026-10-05/mamo-audit.csv)
e [JSON con findings e repair plan](audit-snapshots/production-stabilization-2026-10-05/mamo-audit.json).
Il piano è `executable:false`, ogni proposta `approved:false`: richiede verifica
fonte/variante e controllo immediato dell'identità DB; nessun overwrite/delete.
Per una riparazione futura usare il percorso amministrativo validato esistente,
una identità revisionata alla volta, dopo autorizzazione specifica.

**5. Perché MAMO-EN013 era assente**

VERIFIED LIVE: ora presente, ID `75787708`, Ultra Rare,
`source_provider=manual_authoritative_fix`, `variant_id=''`; metadata indicano
Ultra Rare, Starlight Rare e Grand Master Rare come rarità note. EN012 ed EN014
sono presenti rispettivamente con ID `48393693` e `1186447`.
Il set endpoint corrente conferma EN013 e ID 75787708; il nome fonte è
“Odd-Eyes Pendulum Dragon of the Four Heavenly Dragons”.

**La causa storica precisa non è dimostrata.** Non sono disponibili payload/log
dell'import originario e non è stato trovato un job completo di ingest YGO
equivalente a quello One Piece. I writer verificati comprendono salvataggio
collection singolo/batch e repair amministrativo; non garantiscono da soli un
catalogo globale completo. Le risposte correnti non provano cosa restituiva la
fonte allora. Il bug generale del resolver è riprodotto e corretto, ma non viene
presentato come spiegazione certa dell'omissione live né come backfill del DB.

**6. Varianti**

| Capacità | Stato | Evidenza/limite |
|---|---|---|
| Stesso codice con rarità diverse | SUPPORTED TODAY | Rarity è parte dell'identità DB |
| Varianti con stesso codice/rarità | PARTIALLY SUPPORTED | Unique key include variant_id; metadata disponibili, ma tutte le righe MAMO esportate hanno variant_id vuoto |
| Registry artwork e identità canonica | PARTIALLY SUPPORTED | Alias/override e immagini verificate esistono; il resolver JS deduplica ancora per ID/codice/rarità |
| Assegnazione automatica completa artwork→printing MAMO | NOT SUPPORTED | card_images non dimostra l'assegnazione della singola immagine alla printing |

Proposta separata, DISCUSSED ONLY: definire identità variante YGO con provenienza
verificabile e propagarla attraverso resolver, picker e save RPC. Non assumere
una printing per codice; nessuna grossa migration in questo sprint.

**7. Fast Scan**

LOCAL ONLY: `EXACT`, `NEAR`, `AMBIGUOUS`, `CATALOG_MISSING`, `OCR_INVALID`,
`LOOKUP_TIMEOUT`; `UNRESOLVED`/`LOOKUP_FAILED` conservano l'incertezza invece di
inventare un catalog miss. CATALOG_MISSING richiede lookup completato, codice
normalizzato con numero plausibile e confidence >=88 o consensus >=2 (oppure
input manuale). I match e l'accettazione restano quelli del resolver esistente.
Diagnostica in debug e negli eventi di scansione; nessuna telemetria inviata live.
I miss del controller conservano una cache breve di 20s; il resolver esterno
non conserva più miss permanenti. Un aggiornamento catalogo può quindi richiedere
scadenza della cache breve o una nuova sessione.

Regressione EN013 prima/poi riga catalogo: CATALOG_MISSING → EXACT. Timeout reale
simulato, rete fallita e confidence insufficiente verificati separatamente.
Corpus di 13 casi sintetici con EN/IT, MAMO, RA01/RA02, formato vecchio MIP-I010,
trattino mancante, O/0, I/1/L, garbage, miss e multi-rarità: exact 6, near 3,
review 1, not-found 3, dei quali catalog-missing 1. I contatori not-found e
catalog-missing si sovrappongono. Confidence sono input di fixture dichiarati,
non misure OCR reali. Nessuna camera reale avviata.

**8. Shared Collection — misure**

LOCAL ONLY: campi normalizzati al caricamento; ordinamento riutilizzato finché
dataset/sort non cambiano; cache risultati per query/filtri; due listener
delegati per container; fetch simultanei condividono la stessa promise.
Selezione/draft restano separati dai dati, cap 60 e lazy images preservati.

Benchmark confrontato con HEAD, 5.000 righe × 10 query, risultati e ordine identici:
normalizzazioni 147.013 → 20.010; confronti sort 37.101 → 4.999. Tempi sintetici e
metodologia nel [report](audit-snapshots/production-stabilization-2026-10-05/shared-performance.json).
Non sono una promessa di latenza su telefono.

Browser 360/390/768/1440, 3.000 righe: 1 fetch per 2 load simultanei, 60 tile
iniziali, 120 dopo Load more; una sostituzione griglia per 4 input rapidi;
filter/sort senza risultati obsoleti; toggle singolo anche dopo bind ripetuti;
quantità 2 e selezione conservate; immagini lazy; nessun overflow. Nello stato
finale misurato 574 nodi DOM. Il cap limita le tile, non la dimensione del download.
Raccomandazione DISCUSSED ONLY: pagination/filter server-side se il payload
completo diventa il collo di bottiglia; virtualizzazione solo dopo benchmark
reale di scroll/Load more. Non implementata ora.

**9. Test e classificazione dei fallimenti**

[Registro finale](audit-snapshots/production-stabilization-2026-10-05/test-results.json):
57/57 PASS, incluse 24 Market, Fast Scan, Catalog, Shared, Collection, Deck e
Pagination. Log separati nella stessa directory; benchmark e package check extra
PASS. `git diff --check` PASS (warning CRLF/Git ignore del profilo, non errori diff).

- PRE-EXISTING / ENVIRONMENT: bootstrap e routing dipendevano dal CDN esterno;
  pagina rimaneva `readyState=loading` prima dell'esecuzione di app.js. Il routing
  era inoltre intercettato dal service worker al reload. Test resi offline con
  SDK installato; bypass SW solo nel test routing, non nel prodotto.
- PRE-EXISTING / TEST RACE: snapshot fisso a 50ms poteva osservare documento ancora
  vuoto. Il test guest ora trattiene l'SDK e osserva il guard dopo parsing del
  contenitore, prima di rilasciare app.js; nessuna attenuazione dell'assert privacy.
- NEW TEST-CONTRACT FAILURE, risolto: il mock Fast Scan aveva `ok:false` senza
  status HTTP. Specificato 404 per il miss italiano; 503/network resta errore
  esplicito e ha una regressione dedicata.
- NEW CORPUS FAILURE, risolto: correzione I/1 e L/1 troppo bassa in priorità.
  Tutte le suite esistenti Fast Scan passano dopo la modifica.

**10. File modificati dallo sprint**

Produzione locale: `js/cards.js`, `js/fast-scan-core.js`, `js/fast-scan.js`,
`js/collection-share.js`.
Test esistenti: `scripts/collection-share-guest-smoke.mjs`,
`scripts/collection-share-bootstrap-guard-smoke.mjs`,
`scripts/collection-routing-browser-smoke.mjs`, `scripts/fast-scan-milestone-smoke.mjs`.
Nuovi: `scripts/catalog-printing-completeness-smoke.mjs`,
`scripts/catalog-integrity-audit.mjs`, `scripts/catalog-integrity-audit-smoke.mjs`,
`scripts/fast-scan-catalog-diagnostic-smoke.mjs`,
`scripts/fixtures/fast-scan-stabilization-corpus.json`,
`scripts/collection-share-performance-benchmark.mjs`,
`scripts/production-stabilization-tests.mjs`, `scripts/production-baseline-audit.mjs`,
questo documento e `docs/audit-snapshots/production-stabilization-2026-10-05/`.
Gli altri file dirty appartengono al lavoro precedente. I report storici non
sono stati riscritti; i file canonici Market non sono stati modificati.

**11. Blocker e prossimo rollout sicuro (solo piano)**

1. Separare/revisionare la patch di questo sprint dall'altro lavoro dirty;
   verificare deployment frontend effettivo e strategia cache PWA senza cambiare
   auth/User Edition. Prova manuale scanner su dispositivi reali ancora necessaria.
2. Recuperare il payload/script/log dell'import MAMO originario prima di attribuire
   la causa storica. Revisionare le 163 identità mancanti e le varianti; acquisire
   gli altri export per estendere l'audit all'intero catalogo YGO.
3. Riconciliare le migration per contenuto e scopo, senza applicare in blocco le
   53 versioni locali non abbinate. Il record rolling storico va preservato.
4. Per riprendere Market, con un nuovo mandato live: rieseguire tutti i gate del
   pacchetto canonico (cron pausati/nomi/schedule, 0 run, timezone, Vault secret
   unico non vuoto senza mostrarlo, queue HTTP drenata, backup e hash).
5. Se le sorgenti v58/v3 e RPC corrispondono ancora, evitare redeploy e cron
   duplicati. Verificare canary/log byte; quindi seguire la riattivazione e
   osservazione daily prevista dal pacchetto. Nessuna riattivazione in questo sprint.
6. Verificare al primo daily i contatori byte e i nuovi snapshot/eventi/current;
   interrompere al primo gate fallito. Il rollback canonico lascia i cron pausati.
   Nessun cleanup snapshot/Storage/VACUUM è parte di questo rollout.

**12. SAFE TO COMMIT = NO** per l'intero working tree: include modifiche precedenti
non revisionate da questo sprint. La patch locale elencata è testata e pronta
per revisione/selezione esplicita, non per `git add .`.

**13. SAFE TO DEPLOY = NO** per un rollout complessivo: drift migration, verifiche
frontend/dispositivo e gate live restano da completare. SAFE TO APPLY CLEANUP = NO;
nessuna operazione di retention è stata autorizzata o validata live qui.
